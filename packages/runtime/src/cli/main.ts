#!/usr/bin/env node
/**
 * CIE development CLI (Phase 01). The public CLI comes in Phase 09.
 *
 *   cie dev index  [--workspace <dir>] [--state-dir <dir>] [--json [--timings]]
 *   cie dev status [--workspace <dir>] [--state-dir <dir>] [--json]
 *   cie dev export [--workspace <dir>] [--state-dir <dir>]
 *
 * Exit codes: 0 success, 1 operation failed, 2 usage error.
 *
 * Test hook (P01-12): with CIE_TEST_HOOKS=1 and CIE_TEST_KILL_AT=<stage>, `index` kills its own process with
 * SIGKILL when it reaches that stage. This simulates a hard crash: no cleanup and no lease release.
 */
import { parseArgs } from 'node:util';
import { evaluateFreshness, SYMBOL_KINDS, type DomainError, type IndexStage, type SymbolKind, type SymbolQuery } from '@cie/core';
import { openDevRuntime, type DevRuntime } from '../composition/dev-runtime.js';
import { exportHead } from './export.js';

const USAGE =
  'usage: cie dev <index|status|export> [--workspace <dir>] [--state-dir <dir>] [--json]\n' +
  '       cie dev symbols <query> [--kind <kind>[,<kind>...]] [--limit <n>] [--workspace <dir>] [--state-dir <dir>] [--json]';
const COMMANDS = new Set(['index', 'status', 'export', 'symbols']);

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

/**
 * Measurement for the benchmark harness (P01-13): elapsed milliseconds at each stage boundary, measured
 * in-process from the start of the index command, plus the peak resident set size. Observation only.
 */
function stageRecorder(kill: ((stage: IndexStage) => void) | undefined) {
  const start = performance.now();
  const stagesMs: Partial<Record<IndexStage, number>> = {};
  return {
    onStage: (stage: IndexStage) => {
      stagesMs[stage] = Math.round((performance.now() - start) * 1000) / 1000;
      kill?.(stage);
    },
    report: () => ({
      stagesMs,
      totalMs: Math.round((performance.now() - start) * 1000) / 1000,
      maxRssKb: process.resourceUsage().maxRSS,
    }),
  };
}

async function indexCommand(rt: DevRuntime, json: boolean, timings: boolean): Promise<number> {
  const recorder = stageRecorder(killHook());
  const r = await rt.fullIndex(recorder.onStage);
  if (!r.ok) return fail(r.error);
  const o = r.value;
  if (json) {
    process.stdout.write(`${JSON.stringify(timings ? { ...o, timings: recorder.report() } : o)}\n`);
  } else {
    process.stdout.write(
      `published revision ${o.seq} (${o.manifestHash})\n` +
        `  files: +${o.files.inserted} -${o.files.closed} =${o.files.unchanged}; structure: +${o.structure.inserted} -${o.structure.closed} =${o.structure.unchanged}\n` +
        `  code: ${o.code.extractedFiles} files, ${o.code.symbols} symbols; nodes: +${o.graph.nodes.inserted} -${o.graph.nodes.closed} =${o.graph.nodes.unchanged}; ` +
        `edges: +${o.graph.edges.inserted} -${o.graph.edges.closed} =${o.graph.edges.unchanged}; skipped: ${o.code.skipped.length}; diagnostics: ${o.code.diagnostics}\n` +
        `  ignored: ${o.enumeration.ignored}; unrepresentable names: ${o.enumeration.unrepresentable.length}; unlistable dirs: ${o.enumeration.unlistable.length}` +
        (o.recovered.length > 0 ? `; recovered: ${o.recovered.map((a) => `abandoned r${a.seq}`).join(', ')}` : '') +
        '\n',
    );
  }
  return 0;
}

async function statusCommand(rt: DevRuntime, json: boolean): Promise<number> {
  const languages = await rt.languages();
  if (!languages.ok) return fail(languages.error);
  const head = await rt.index.store.head();
  const unfinished = await rt.index.store.listUnfinished();
  const status = {
    revision: head?.seq ?? null,
    // Phase 01 has no change log yet (Phase 05): freshness is current once anything has been published.
    freshness: evaluateFreshness({ headWatermark: head?.watermark ?? null, latestRelevantChangeSeq: null, changeTracking: 'reliable' }),
    unfinishedRevisions: unfinished.map((u) => u.seq),
    leaseHolder: rt.index.store.lease.currentHolder(),
    llmProvider: rt.user.llmProvider,
    // Effective fidelity per language and capability (CODE_INTELLIGENCE_STRATEGY §5), from the registered adapters.
    capabilities: Object.fromEntries(languages.value.capabilityMatrix().map((p) => [p.language, p.fidelity])),
  };
  process.stdout.write(json ? `${JSON.stringify(status)}\n` : `${Object.entries(status).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n`);
  return 0;
}

function parseSymbolQuery(text: string, limit: string | undefined, kind: string | undefined): SymbolQuery | { error: string } {
  let n: number | undefined;
  if (limit !== undefined) {
    n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1) return { error: `--limit must be a positive integer, got "${limit}"` };
  }
  const kinds = kind === undefined ? undefined : kind.split(',').map((k) => k.trim());
  const unknown = kinds?.filter((k) => !(SYMBOL_KINDS as readonly string[]).includes(k)) ?? [];
  if (unknown.length > 0) return { error: `unknown --kind: ${unknown.join(', ')} (one of ${SYMBOL_KINDS.join(', ')})` };
  return { text, ...(n === undefined ? {} : { limit: n }), ...(kinds === undefined ? {} : { kinds: kinds as SymbolKind[] }) };
}

/** Text output is 1-based (line:col, as editors show); JSON keeps the 0-based SourceRange of the protocol. */
async function symbolsCommand(rt: DevRuntime, query: SymbolQuery, json: boolean): Promise<number> {
  const head = await rt.index.store.head();
  if (head === null) return fail({ code: 'INDEX_NOT_READY', message: 'nothing has been indexed yet' });
  const r = await rt.index.store.searchSymbols(head.seq, query);
  if (!r.ok) return fail(r.error);
  const { hits, truncated } = r.value;
  if (json) {
    process.stdout.write(`${JSON.stringify({ revision: head.seq, hits, truncated })}\n`);
    return 0;
  }
  const lines = hits.map((h) => `${h.kind.padEnd(11)} ${h.qualifiedName}  ${h.path}:${h.range.startLine + 1}:${h.range.startCol + 1}`);
  if (hits.length === 0) lines.push('no symbols match');
  if (truncated) lines.push(`… more results; raise --limit (now ${hits.length})`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        workspace: { type: 'string' },
        'state-dir': { type: 'string' },
        json: { type: 'boolean' },
        timings: { type: 'boolean' },
        limit: { type: 'string' },
        kind: { type: 'string' },
      },
    });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  const [group, command, ...rest] = parsed.positionals;
  if (group !== 'dev' || command === undefined || !COMMANDS.has(command) || (command === 'symbols') !== (rest.length > 0)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const query = command === 'symbols' ? parseSymbolQuery(rest.join(' '), parsed.values.limit, parsed.values.kind) : null;
  if (query !== null && 'error' in query) {
    process.stderr.write(`${query.error}\n${USAGE}\n`);
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
    return await dispatch(rt.value, command, query, parsed.values.json === true, parsed.values.timings === true);
  } finally {
    rt.value.close();
  }
}

async function dispatch(rt: DevRuntime, command: string, query: SymbolQuery | null, json: boolean, timings: boolean): Promise<number> {
  if (command === 'index') return indexCommand(rt, json, timings);
  if (command === 'status') return statusCommand(rt, json);
  if (query !== null) return symbolsCommand(rt, query, json);
  const exported = await exportHead(rt);
  if (!exported.ok) return fail(exported.error);
  process.stdout.write(exported.value);
  return 0;
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
