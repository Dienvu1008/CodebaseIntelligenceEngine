#!/usr/bin/env node
/**
 * CIE development CLI (Phase 01). The public CLI comes in Phase 09.
 *
 *   cie dev index  [--workspace <dir>] [--state-dir <dir>] [--json]
 *   cie dev status [--workspace <dir>] [--state-dir <dir>] [--json]
 *   cie dev export [--workspace <dir>] [--state-dir <dir>]
 *
 * Exit codes: 0 success, 1 operation failed, 2 usage error.
 *
 * Test hook (P01-12): with CIE_TEST_HOOKS=1 and CIE_TEST_KILL_AT=<stage>, `index` kills its own process with
 * SIGKILL when it reaches that stage. This simulates a hard crash: no cleanup and no lease release.
 */
import { parseArgs } from 'node:util';
import { evaluateFreshness, type DomainError, type IndexStage } from '@cie/core';
import { openDevRuntime, type DevRuntime } from '../composition/dev-runtime.js';
import { exportHead } from './export.js';

const USAGE = 'usage: cie dev <index|status|export> [--workspace <dir>] [--state-dir <dir>] [--json]';

function fail(error: DomainError): number {
  process.stderr.write(`cie: ${error.code}: ${error.message}\n`);
  return 1;
}

function killHook(): ((stage: IndexStage) => void) | undefined {
  const at = process.env['CIE_TEST_KILL_AT'];
  if (process.env['CIE_TEST_HOOKS'] !== '1' || at === undefined) return undefined;
  return (stage) => {
    if (stage === at) process.kill(process.pid, 'SIGKILL');
  };
}

async function indexCommand(rt: DevRuntime, json: boolean): Promise<number> {
  const r = await rt.fullIndex(killHook());
  if (!r.ok) return fail(r.error);
  const o = r.value;
  if (json) {
    process.stdout.write(`${JSON.stringify(o)}\n`);
  } else {
    process.stdout.write(
      `published revision ${o.seq} (${o.manifestHash})\n` +
        `  files: +${o.files.inserted} -${o.files.closed} =${o.files.unchanged}; structure: +${o.structure.inserted} -${o.structure.closed} =${o.structure.unchanged}\n` +
        `  ignored: ${o.enumeration.ignored}; unrepresentable names: ${o.enumeration.unrepresentable.length}; unlistable dirs: ${o.enumeration.unlistable.length}` +
        (o.recovered.length > 0 ? `; recovered: ${o.recovered.map((a) => `abandoned r${a.seq}`).join(', ')}` : '') +
        '\n',
    );
  }
  return 0;
}

async function statusCommand(rt: DevRuntime, json: boolean): Promise<number> {
  const head = await rt.index.store.head();
  const unfinished = await rt.index.store.listUnfinished();
  const status = {
    revision: head?.seq ?? null,
    // Phase 01 has no change log yet (Phase 05): freshness is current once anything has been published.
    freshness: evaluateFreshness({ headWatermark: head?.watermark ?? null, latestRelevantChangeSeq: null, changeTracking: 'reliable' }),
    unfinishedRevisions: unfinished.map((u) => u.seq),
    leaseHolder: rt.index.store.lease.currentHolder(),
    llmProvider: rt.user.llmProvider,
  };
  process.stdout.write(json ? `${JSON.stringify(status)}\n` : `${Object.entries(status).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { workspace: { type: 'string' }, 'state-dir': { type: 'string' }, json: { type: 'boolean' } },
    });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  const [group, command] = parsed.positionals;
  if (group !== 'dev' || (command !== 'index' && command !== 'status' && command !== 'export')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const stateDir = parsed.values['state-dir'];
  const rt = await openDevRuntime({
    workspaceRoot: parsed.values.workspace ?? process.cwd(),
    mode: command === 'index' ? 'writer' : 'follower',
    ...(stateDir === undefined ? {} : { stateDir }),
  });
  if (!rt.ok) return fail(rt.error);
  try {
    const json = parsed.values.json === true;
    if (command === 'index') return await indexCommand(rt.value, json);
    if (command === 'status') return await statusCommand(rt.value, json);
    const exported = await exportHead(rt.value);
    if (!exported.ok) return fail(exported.error);
    process.stdout.write(exported.value);
    return 0;
  } finally {
    rt.value.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`cie: internal error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
