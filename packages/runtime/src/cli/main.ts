#!/usr/bin/env node
/**
 * CIE development CLI (Phase 01). The public CLI comes in Phase 09.
 *
 *   cie dev index  [--workspace <dir>] [--state-dir <dir>] [--json [--timings]]
 *   cie dev status [--workspace <dir>] [--state-dir <dir>] [--json]
 *   cie dev export [--workspace <dir>] [--state-dir <dir>]
 *   cie dev symbols <query> [--kind …] [--limit <n>]
 *   cie dev <deps|refs|impact> <node-id> [--depth <n>] [--limit <n>]   (bounded graph traversal, KG-004)
 *   cie dev neighbors <node-id> [--direction <in|out>] [--type …] [--limit <n>]
 *
 * Exit codes: 0 success, 1 operation failed, 2 usage error.
 *
 * Test hook (P01-12): with CIE_TEST_HOOKS=1 and CIE_TEST_KILL_AT=<stage>, `index` kills its own process with
 * SIGKILL when it reaches that stage. This simulates a hard crash: no cleanup and no lease release.
 */
import { parseArgs } from 'node:util';
import {
  evaluateFreshness,
  graphQueries,
  parseNodeId,
  SYMBOL_KINDS,
  type Direction,
  type DomainError,
  type GraphQueries,
  type IndexStage,
  type NodeId,
  type NodeQueryResult,
  type RevisionSeq,
  type SymbolKind,
  type SymbolQuery,
} from '@cie/core';
import { openDevRuntime, type DevRuntime } from '../composition/dev-runtime.js';
import { exportHead } from './export.js';

const USAGE =
  'usage: cie dev <index|status|export> [--workspace <dir>] [--state-dir <dir>] [--json]\n' +
  '       cie dev symbols <query> [--kind <kind>[,<kind>...]] [--limit <n>] [--workspace <dir>] [--state-dir <dir>] [--json]\n' +
  '       cie dev <deps|refs|impact> <node-id> [--depth <n>] [--limit <n>] [--workspace <dir>] [--state-dir <dir>] [--json]\n' +
  '       cie dev neighbors <node-id> [--direction <in|out>] [--type <t>[,<t>...]] [--limit <n>] [--workspace <dir>] [--state-dir <dir>] [--json]';
const COMMANDS = new Set(['index', 'status', 'export', 'symbols', 'deps', 'refs', 'impact', 'neighbors']);
/** Commands that take a single node-id positional. */
const GRAPH_COMMANDS = new Set(['deps', 'refs', 'impact', 'neighbors']);

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
        `  spans: ${o.spans.checked}/${o.spans.total} rehashed` + (o.spans.unverifiable > 0 ? `, ${o.spans.unverifiable} unverifiable (changed during index)` : '') + '\n' +
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

/** Parses the optional bounds shared by the graph commands. */
function parseBounds(depth: string | undefined, limit: string | undefined): { maxDepth?: number; limit?: number } | { error: string } {
  const out: { maxDepth?: number; limit?: number } = {};
  for (const [flag, raw] of [['--depth', depth], ['--limit', limit]] as const) {
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) return { error: `${flag} must be a positive integer, got "${raw}"` };
    if (flag === '--depth') out.maxDepth = n;
    else out.limit = n;
  }
  return out;
}

function renderTraversal(command: string, nodeId: string, r: NodeQueryResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify({ node: nodeId, found: r.found, nodes: r.nodes, truncated: r.truncated })}\n`);
    return 0;
  }
  if (!r.found) {
    process.stdout.write(`${command}: node not found at head: ${nodeId}\n`);
    return 0;
  }
  const lines = r.nodes.map((n) => `${'·'.repeat(n.depth)}${n.depth > 0 ? ' ' : ''}${n.id}  [depth ${n.depth}, ${n.status}]`);
  if (r.nodes.length === 0) lines.push(`no ${command} edges from ${nodeId}`);
  if (r.truncated) lines.push(`… more; raise --depth/--limit (now ${r.nodes.length})`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function neighborsCommand(q: GraphQueries, seq: RevisionSeq, nodeArg: string, node: NodeId, opts: GraphOpts, json: boolean): Promise<number> {
  if (opts.direction !== undefined && opts.direction !== 'in' && opts.direction !== 'out') return fail({ code: 'QUERY_ARG_INVALID', message: '--direction must be in or out' });
  const direction: Direction = opts.direction === 'in' ? 'in' : 'out';
  const types = opts.type === undefined ? [] : opts.type.split(',').map((t) => t.trim());
  const bounds = parseBounds(undefined, opts.limit);
  if ('error' in bounds) return fail({ code: 'QUERY_ARG_INVALID', message: bounds.error });
  const r = await q.neighbors(seq, node, direction, types as never, bounds.limit);
  if (!r.ok) return fail(r.error);
  if (json) {
    process.stdout.write(`${JSON.stringify({ node: nodeArg, found: r.value.found, direction, groups: r.value.result.groups })}\n`);
    return 0;
  }
  if (!r.value.found) {
    process.stdout.write(`neighbors: node not found at head: ${nodeArg}\n`);
    return 0;
  }
  const lines = r.value.result.groups.flatMap((g) => [
    `${g.type} (${direction})${g.truncated ? ' …more' : ''}:`,
    ...g.edges.map((e) => `  ${e.node}  [${e.status}${e.precision === null ? '' : `, ${e.precision}`}]`),
  ]);
  if (lines.length === 0) lines.push(`no edges ${direction} of ${nodeArg}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function graphCommand(rt: DevRuntime, command: string, nodeArg: string, opts: GraphOpts, json: boolean): Promise<number> {
  const head = await rt.index.store.head();
  if (head === null) return fail({ code: 'INDEX_NOT_READY', message: 'nothing has been indexed yet' });
  const node = parseNodeId(nodeArg);
  if (!node.ok) return fail(node.error);
  const q = graphQueries({ graph: rt.index.store });
  if (command === 'neighbors') return neighborsCommand(q, head.seq, nodeArg, node.value, opts, json);

  const bounds = parseBounds(opts.depth, opts.limit);
  if ('error' in bounds) return fail({ code: 'QUERY_ARG_INVALID', message: bounds.error });
  const run = command === 'deps' ? q.deps : command === 'impact' ? q.impact : q.refs;
  const r = await run(head.seq, node.value, bounds);
  if (!r.ok) return fail(r.error);
  return renderTraversal(command, nodeArg, r.value, json);
}

const CLI_OPTIONS = {
  workspace: { type: 'string' },
  'state-dir': { type: 'string' },
  json: { type: 'boolean' },
  timings: { type: 'boolean' },
  limit: { type: 'string' },
  kind: { type: 'string' },
  depth: { type: 'string' },
  direction: { type: 'string' },
  type: { type: 'string' },
} as const;

type CliValues = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof CLI_OPTIONS }>>['values'];

/** Parsed CLI invocation, or a `usage` exit code when positionals or the command are invalid. */
type Invocation = { readonly command: string; readonly rest: readonly string[]; readonly values: CliValues } | { readonly usage: 2 };

function parseInvocation(argv: readonly string[]): Invocation | { readonly error: string } {
  let values: CliValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv], allowPositionals: true, options: CLI_OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const [group, command, ...rest] = positionals;
  const takesPositional = command === 'symbols' || (command !== undefined && GRAPH_COMMANDS.has(command));
  if (group !== 'dev' || command === undefined || !COMMANDS.has(command) || takesPositional !== (rest.length > 0)) return { usage: 2 };
  return { command, rest, values };
}

export async function main(argv: readonly string[]): Promise<number> {
  const inv = parseInvocation(argv);
  if ('error' in inv) {
    process.stderr.write(`${inv.error}\n${USAGE}\n`);
    return 2;
  }
  if ('usage' in inv) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const { command, rest, values: parsedValues } = inv;
  const query = command === 'symbols' ? parseSymbolQuery(rest.join(' '), parsedValues.limit, parsedValues.kind) : null;
  if (query !== null && 'error' in query) {
    process.stderr.write(`${query.error}\n${USAGE}\n`);
    return 2;
  }
  const stateDir = parsedValues['state-dir'];
  const rt = await openDevRuntime({
    workspaceRoot: parsedValues.workspace ?? process.cwd(),
    mode: command === 'index' ? 'writer' : 'follower',
    ...(stateDir === undefined ? {} : { stateDir }),
  });
  if (!rt.ok) return fail(rt.error);
  try {
    return await dispatch(rt.value, command, query, rest[0] ?? null, parsedValues, parsedValues.json === true, parsedValues.timings === true);
  } finally {
    rt.value.close();
  }
}

interface GraphOpts {
  readonly depth?: string;
  readonly direction?: string;
  readonly type?: string;
  readonly limit?: string;
}
type CliFlags = GraphOpts;

async function dispatch(rt: DevRuntime, command: string, query: SymbolQuery | null, nodeArg: string | null, flags: CliFlags, json: boolean, timings: boolean): Promise<number> {
  if (command === 'index') return indexCommand(rt, json, timings);
  if (command === 'status') return statusCommand(rt, json);
  if (query !== null) return symbolsCommand(rt, query, json);
  if (GRAPH_COMMANDS.has(command) && nodeArg !== null) {
    const opts = {
      ...(flags.depth === undefined ? {} : { depth: flags.depth }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
      ...(flags.direction === undefined ? {} : { direction: flags.direction }),
      ...(flags.type === undefined ? {} : { type: flags.type }),
    };
    return graphCommand(rt, command, nodeArg, opts, json);
  }
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
