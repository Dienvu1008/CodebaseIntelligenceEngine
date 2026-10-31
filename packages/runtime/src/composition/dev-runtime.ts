/**
 * Composition root for the out-of-process runtime (SYSTEM_ARCHITECTURE §6, ADR-0002). This is the only
 * place where adapters are wired to core ports. Phase 01 wires the development runtime used by `cie dev`.
 * There is no LLM provider: `llm-none` is implicit, because nothing in Phase 01 can call a model (AI-004).
 */
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultUserConfigDir,
  FileConfigSource,
  GuardedFileSystem,
  JsonWorkspaceRepository,
  newWorkspaceId,
  NodeHasher,
  openIndexStore,
  openStateStore,
  SystemClock,
  WriteConfinement,
  type OpenedIndexStore,
  type OpenedStateStore,
} from '@cie/adapters';
import {
  domainError,
  enumerateWorkspace,
  err,
  ok,
  runFullIndex,
  type Clock,
  type DomainError,
  type IndexOutcome,
  type IndexStage,
  type JobId,
  type JobRecord,
  type LanguageRegistry,
  type Result,
  type UserSettings,
  type WorkspaceId,
  type WorkspaceSettings,
} from '@cie/core';
import { createLanguageRegistry } from './languages.js';

export interface DevRuntimeOptions {
  readonly workspaceRoot: string;
  /** --state-dir: an absolute directory outside the workspace; defaults to <workspace>/.cie. */
  readonly stateDir?: string;
  readonly mode: 'writer' | 'follower';
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  /** Span hashes rehashed before each publish (SY-003 b); null rehashes all. Defaults to DEFAULT_SPAN_SAMPLE. */
  readonly spanSample?: number | null;
}

export interface DevRuntime {
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly workspaceId: WorkspaceId;
  readonly settings: WorkspaceSettings;
  readonly user: UserSettings;
  readonly holder: string;
  readonly index: OpenedIndexStore;
  /** Registered language adapters (created on first use); `capabilityMatrix()` is what `cie dev status` reports. */
  languages(): Promise<Result<LanguageRegistry, DomainError>>;
  /** Runs one full index. `onStage` observes progress (and powers crash-injection tests). */
  fullIndex(onStage?: (stage: IndexStage) => void | Promise<void>): Promise<Result<IndexOutcome, DomainError>>;
  /** Most recent jobs (writer runtimes only; followers do not open state.db). */
  recentJobs(limit: number): readonly JobRecord[];
  close(): void;
}

/** Lease TTL. Long enough to cover a full index of the small tier between renewals; tuned in Phase 05. */
export const LEASE_TTL_MS = 120_000;

/** Lease holder ids look like `host|pid|nonce`, so the runtime can detect dead local holders. */
const makeHolder = (): string => `${hostname()}|${process.pid}|${randomUUID().slice(0, 8)}`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // the process exists but belongs to someone else
  }
}

/**
 * Crash recovery without waiting for the TTL: if the lease belongs to a process on THIS machine that no longer
 * exists, release it. A lease from another host is never broken (it might be a network share).
 */
function breakDeadLocalHolder(index: OpenedIndexStore): string | null {
  const holder = index.store.lease.currentHolder();
  if (holder === null) return null;
  const [host, pidText] = holder.split('|');
  const pid = Number(pidText);
  if (host !== hostname() || !Number.isSafeInteger(pid) || pid === process.pid || isProcessAlive(pid)) return null;
  return index.store.lease.breakStaleLease(holder) ? holder : null;
}

async function resolveIdentity(stateDir: string, confinement: WriteConfinement, mode: 'writer' | 'follower', clock: Clock): Promise<Result<WorkspaceId, DomainError>> {
  const repo = new JsonWorkspaceRepository(stateDir, confinement);
  const existing = await repo.load();
  if (existing !== null) return ok(existing.id);
  if (mode === 'follower') return err(domainError('INDEX_NOT_READY', 'this workspace has not been indexed yet'));
  const id = newWorkspaceId();
  const created = await repo.initialize({ id, createdAt: new Date(clock.nowMs()).toISOString() });
  return created.ok ? ok(id) : created;
}

export async function openDevRuntime(opts: DevRuntimeOptions): Promise<Result<DevRuntime, DomainError>> {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? new SystemClock();
  const fs = await GuardedFileSystem.open(opts.workspaceRoot);
  const stateDir = opts.stateDir === undefined ? path.join(fs.root, '.cie') : path.resolve(opts.stateDir);
  const userConfigDir = defaultUserConfigDir(env, process.platform, homedir());
  let confinement: WriteConfinement;
  try {
    confinement = await WriteConfinement.create({ workspaceRoot: fs.root, stateDir, userConfigDir });
  } catch (e) {
    return err(domainError('INVALID_STATE_DIR', e instanceof Error ? e.message : String(e)));
  }
  const config = new FileConfigSource(fs, userConfigDir);
  const settings = await config.workspace();
  if (!settings.ok) return settings;
  const user = await config.user();
  if (!user.ok) return user;
  const workspaceId = await resolveIdentity(stateDir, confinement, opts.mode, clock);
  if (!workspaceId.ok) return workspaceId;
  const holder = makeHolder();
  const index = await openIndexStore({ stateDir, workspaceId: workspaceId.value, clock, mode: opts.mode, holder, confinement });
  if (!index.ok) return index;
  // state.db is writer-only: followers never migrate or create it.
  let state: OpenedStateStore | null = null;
  if (opts.mode === 'writer') {
    const opened = await openStateStore({ stateDir, workspaceId: workspaceId.value, clock, confinement });
    if (!opened.ok) {
      index.value.close();
      return opened;
    }
    state = opened.value;
  }
  const hasher = new NodeHasher();
  // Created on first use: loading and verifying the grammars is wasted work for `dev export`.
  let registry: Promise<Result<LanguageRegistry, DomainError>> | undefined;
  const languages = (): Promise<Result<LanguageRegistry, DomainError>> => (registry ??= createLanguageRegistry(hasher));

  return ok({
    workspaceRoot: fs.root,
    stateDir,
    workspaceId: workspaceId.value,
    settings: settings.value,
    user: user.value,
    holder,
    index: index.value,
    languages,
    async fullIndex(onStage) {
      const registered = await languages();
      if (!registered.ok) return registered;
      breakDeadLocalHolder(index.value);
      const controller = new AbortController();
      return runFullIndex({
        store: index.value.store,
        lease: index.value.store.lease,
        holder,
        leaseTtlMs: LEASE_TTL_MS,
        jobId: `job_${randomUUID()}` as JobId,
        hasher,
        signal: controller.signal,
        enumerate: () => enumerateWorkspace({ fs, hasher, settings: settings.value, signal: controller.signal }),
        ...(onStage === undefined ? {} : { onStage }),
        ...(state === null ? {} : { jobs: state.jobs }),
        code: { registry: registered.value, fs },
        ...(opts.spanSample === undefined ? {} : { spanSample: opts.spanSample }),
      });
    },
    recentJobs: (limit) => state?.jobs.recent(limit) ?? [],
    close: () => {
      state?.close();
      index.value.close();
    },
  });
}
