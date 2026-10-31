import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIndexStore, WriteConfinement, type OpenedIndexStore } from '@cie/adapters';
import {
  canonicalizePath,
  changeSeq,
  deriveStructure,
  parseContentHash,
  type CanonicalPath,
  type ChangeSeq,
  type Clock,
  type JobId,
  type ManifestEntry,
  type RevisionSeq,
  type WorkspaceId,
} from '@cie/core';

/** Deterministic, manually advanced clock. */
export class FakeClock implements Clock {
  constructor(private ms = 1_000_000) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const WS_A = 'ws_A' as WorkspaceId;
export const WS_B = 'ws_B' as WorkspaceId;
export const job = (id: string): JobId => id as JobId;
export const cseq = (n: number): ChangeSeq => {
  const r = changeSeq(n);
  if (!r.ok) throw new Error('bad change seq');
  return r.value;
};

export function cpath(raw: string): CanonicalPath {
  const r = canonicalizePath(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
}

export function file(p: string, hexChar: string, size = 1, language: string | null = 'ts'): ManifestEntry {
  const h = parseContentHash(`sha256:${hexChar.repeat(64)}`);
  if (!h.ok) throw new Error('bad hash');
  return { path: cpath(p), status: 'indexed', hash: h.value, size, language };
}

export interface Sandbox {
  readonly dir: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly clock: FakeClock;
  open(opts?: { holder?: string; mode?: 'writer' | 'follower'; workspaceId?: WorkspaceId }): Promise<OpenedIndexStore>;
  dispose(): void;
}

export async function sandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cie-store-'));
  const workspace = path.join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const stateDir = path.join(workspace, '.cie');
  const clock = new FakeClock();
  const confinement = await WriteConfinement.create({ workspaceRoot: workspace });
  const opened: OpenedIndexStore[] = [];
  return {
    dir,
    workspace,
    stateDir,
    clock,
    async open(opts = {}) {
      const r = await openIndexStore({
        stateDir,
        workspaceId: opts.workspaceId ?? WS_A,
        clock,
        mode: opts.mode ?? 'writer',
        holder: opts.holder ?? 'writer-1',
        confinement,
      });
      if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      opened.push(r.value);
      return r.value;
    },
    dispose() {
      for (const o of opened) {
        try {
          o.close();
        } catch {
          // already closed
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Stages the manifest and its derived structure (both are required before validation). Throws on failure. */
export async function stageAll(o: OpenedIndexStore, seq: RevisionSeq, entries: readonly ManifestEntry[]): Promise<void> {
  const files = await o.store.stageManifest(seq, entries);
  if (!files.ok) throw new Error(files.error.code);
  const structure = await o.store.stageStructure(seq, deriveStructure(entries));
  if (!structure.ok) throw new Error(structure.error.code);
}

/** Builds and publishes one revision with the given manifest. Throws on any failure. */
export async function publishRevision(
  o: OpenedIndexStore,
  entries: readonly ManifestEntry[],
  watermark = 0,
): Promise<RevisionSeq> {
  const head = await o.store.head();
  const rev = await o.store.begin(head?.seq ?? null, job(`job-${Math.random().toString(36).slice(2)}`));
  if (!rev.ok) throw new Error(rev.error.code);
  const staged = await o.store.stageManifest(rev.value.seq, entries);
  if (!staged.ok) throw new Error(staged.error.code);
  const structure = await o.store.stageStructure(rev.value.seq, deriveStructure(entries));
  if (!structure.ok) throw new Error(structure.error.code);
  const v = await o.store.markValidating(rev.value.seq);
  if (!v.ok) throw new Error(v.error.code);
  const p = await o.store.publish(rev.value.seq, cseq(watermark));
  if (!p.ok) throw new Error(p.error.code);
  return rev.value.seq;
}

/** Order-sensitive digest of everything visible at a published seq (SN-007). */
export async function digestAt(o: OpenedIndexStore, seq: RevisionSeq): Promise<string> {
  const r = await o.store.filesAt(seq);
  if (!r.ok) throw new Error(r.error.code);
  return createHash('sha256').update(JSON.stringify(r.value)).digest('hex');
}
