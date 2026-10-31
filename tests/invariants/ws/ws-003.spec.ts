// WS-003: workspace isolation. A store whose meta.workspace_id differs from the bound workspace is refused,
// never silently reused or replaced. Part (c), rejecting requests for another workspace, arrives with the
// protocol handler (Phase 06).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { file, publishRevision, sandbox, WS_B, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('WS-003: store binding', () => {
  it('refuses to open a workspace A index as workspace B, and leaves the file untouched', async () => {
    const a = await sb.open();
    await a.store.lease.acquire('writer-1', 60_000);
    await publishRevision(a, [file('a.ts', 'a')]);
    a.close();
    const dbFile = path.join(sb.stateDir, 'index.db');
    const bytes = readFileSync(dbFile);

    await expect(sb.open({ workspaceId: WS_B })).rejects.toMatchObject({ code: 'STORE_WORKSPACE_MISMATCH' });
    await expect(sb.open({ workspaceId: WS_B, mode: 'follower' })).rejects.toMatchObject({ code: 'STORE_WORKSPACE_MISMATCH' });
    expect(readFileSync(dbFile).equals(bytes)).toBe(true);

    const again = await sb.open(); // the rightful workspace still opens it
    expect(again.outcome).toBe('opened');
    expect((await again.store.head())?.seq).toBe(1);
  });
});
