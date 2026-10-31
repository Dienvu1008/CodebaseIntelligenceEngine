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
  SystemClock,
  WriteConfinement,
  type OpenedIndexStore,
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
  type Result,
  type UserSettings,
  type WorkspaceId,
  type WorkspaceSettings,
} from '@cie/core';

export interface DevRuntimeOptions {
  readonly workspaceRoot: string;
  /** --state-dir: an absolute directory outside the workspace; defaults to <workspace>/.cie. */
  readonly stateDir?: string;
  readonly mode: 'writer' | 'follower';
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
}

export interface DevRuntime {
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly workspaceId: WorkspaceId;
  readonly settings: WorkspaceSettings;
  readonly user: UserSettings;
  readonly holder: string;
  readonly index: OpenedIndexStore;
  /** Runs one full index. `onStage` observes progress (and powers crash-injection tests). */
  fullIndex(onStage?: (stage: IndexStage) => void | Promise<void>): Promise<Result<IndexOutcome, DomainError>>;
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
  const hasher = new NodeHasher();

  return ok({
    workspaceRoot: fs.root,
    stateDir,
    workspaceId: workspaceId.value,
    settings: settings.value,
    user: user.value,
    holder,
    index: index.value,
    async fullIndex(onStage) {
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
      });
    },
    close: () => index.value.close(),
  });
}
