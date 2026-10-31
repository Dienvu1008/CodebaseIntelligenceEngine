/**
 * WorkspaceRepository backed by <stateDir>/workspace.json (FR-001, WS-003). It is written once, atomically
 * (temp file plus rename) and through WriteConfinement (SEC-002).
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { domainError, err, ok, type DomainError, type Result, type WorkspaceId, type WorkspaceIdentity, type WorkspaceRepository } from '@cie/core';
import type { WriteConfinement } from './write-confinement.js';

const ID_PATTERN = /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const newWorkspaceId = (): WorkspaceId => `ws_${randomUUID()}` as WorkspaceId;

export class JsonWorkspaceRepository implements WorkspaceRepository {
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly confinement: WriteConfinement,
  ) {
    this.file = path.join(stateDir, 'workspace.json');
  }

  async load(): Promise<WorkspaceIdentity | null> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const parsed = JSON.parse(text) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id !== 'string' || !ID_PATTERN.test(parsed.id) || typeof parsed.createdAt !== 'string') {
      throw new Error('workspace.json is malformed');
    }
    return { id: parsed.id as WorkspaceId, createdAt: parsed.createdAt };
  }

  async initialize(identity: WorkspaceIdentity): Promise<Result<void, DomainError>> {
    const allowed = await this.confinement.check(this.file, 'state');
    if (!allowed.ok) return allowed;
    if ((await this.load()) !== null) return err(domainError('WORKSPACE_ALREADY_INITIALIZED', 'workspace.json already exists'));
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify({ id: identity.id, createdAt: identity.createdAt }, null, 2)}\n`, { flag: 'wx' });
    await rename(tmp, this.file);
    return ok(undefined);
  }
}
