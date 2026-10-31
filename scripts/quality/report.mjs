#!/usr/bin/env node
// @ts-check
/**
 * Extraction quality report (P02-13, IMPLEMENTATION_ROADMAP Phase 02 acceptance). It measures and records; it
 * never judges. There are no thresholds.
 *
 *  1. Against the TypeScript compiler (TS, TSX, JS): every workspace is indexed through the real CLI, and its
 *     published symbols are compared with an independent oracle built from `ts.createSourceFile`. The oracle
 *     uses the Phase 02 symbol scope: module-level declarations; class, interface, type-literal-alias, enum and
 *     namespace members (parameter properties included); function and class declarations at any depth; never
 *     locals, parameters or object-literal members. Ids come from @cie/core identifySymbols / encodeNameSegment,
 *     so both sides use the same identity rules (ADR-0014) and only the declarations themselves can differ.
 *  2. Against the hand-verified ground truth of every golden fixture (fixtures/<name>.truth.json): symbols,
 *     imports and named import bindings, for every language (the only oracle for Python).
 *
 *   node scripts/quality/report.mjs [--workspace <dir> --id <name>]... [--out <file>]
 * Without --workspace it reports the golden fixtures only. Results go to benchmarks/results/.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, TextDecoder } from 'node:util';
import ts from 'typescript';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CLI = path.join(REPO, 'packages', 'runtime', 'dist', 'cli', 'main.js');
/** @type {typeof import('@cie/core')} */
const core = await import(pathToFileURL(path.join(REPO, 'packages', 'core', 'dist', 'index.js')).href);

const GOLDEN = [...readFileSync(path.join(REPO, 'tests', 'helpers', 'golden.ts'), 'utf8').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
const LANG_BY_EXT = /** @type {Record<string, [string, ts.ScriptKind]>} */ ({
  ts: ['ts', ts.ScriptKind.TS], mts: ['ts', ts.ScriptKind.TS], cts: ['ts', ts.ScriptKind.TS], tsx: ['tsx', ts.ScriptKind.TSX],
  js: ['js', ts.ScriptKind.JS], mjs: ['js', ts.ScriptKind.JS], cjs: ['js', ts.ScriptKind.JS], jsx: ['js', ts.ScriptKind.JSX],
});

// ------------------------------------------------------------------ CIE side

/** Indexes a workspace into a throwaway state dir and returns its cie-export/2 document. */
function exportOf(/** @type {string} */ workspace) {
  const state = mkdtempSync(path.join(tmpdir(), 'cie-quality-'));
  try {
    const env = { ...process.env, CIE_CONFIG_DIR: path.join(state, 'user-config') };
    const opts = { encoding: /** @type {const} */ ('utf8'), env, maxBuffer: 1024 * 1024 * 1024 };
    const indexed = spawnSync(process.execPath, [CLI, 'dev', 'index', '--json', '--workspace', workspace, '--state-dir', state], opts);
    if (indexed.status !== 0) throw new Error(`index failed for ${workspace}: ${indexed.stderr}`);
    const exported = spawnSync(process.execPath, [CLI, 'dev', 'export', '--workspace', workspace, '--state-dir', state], opts);
    if (exported.status !== 0) throw new Error(`export failed for ${workspace}: ${exported.stderr}`);
    return { doc: JSON.parse(exported.stdout), outcome: JSON.parse(indexed.stdout) };
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ TypeScript compiler oracle

const isFunctionValue = (/** @type {ts.Node | undefined} */ n) => n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
const hasModifier = (/** @type {ts.Node} */ n, /** @type {ts.SyntaxKind} */ k) => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []).some((m) => m.kind === k) : false);

/** Source-level name of a declaration name node (unquoted strings, `#private`, `[computed]`). */
function nameText(/** @type {ts.Node | undefined} */ name, /** @type {ts.SourceFile} */ sf) {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return name.getText(sf);
  return null;
}

/**
 * Declarations of one file in document order: { path: name segments, kind }.
 * @param {ts.SourceFile} sf
 */
function oracleDeclarations(sf) {
  /** @type {{ path: string[], kind: string }[]} */
  const out = [];
  const add = (/** @type {string[]} */ container, /** @type {string} */ name, /** @type {string} */ kind) => {
    const p = [...container, core.encodeNameSegment(name)];
    out.push({ path: p, kind });
    return p;
  };
  // ADR-0014: an unnamed declaration that is not the default export is `<anon@n>`, n counted per container.
  const anonCounts = new Map();
  const anon = (/** @type {string[]} */ container) => {
    const key = container.join('\u0000');
    const n = (anonCounts.get(key) ?? 0) + 1;
    anonCounts.set(key, n);
    return core.anonymousName(n);
  };
  const unnamed = (/** @type {ts.Node} */ node, /** @type {string[]} */ container) =>
    hasModifier(node, ts.SyntaxKind.DefaultKeyword) || (node.parent !== undefined && ts.isExportAssignment(node.parent)) ? 'default' : anon(container);

  /** @param {ts.Node} node @param {string[]} container @param {boolean} moduleLevel */
  function visit(node, container, moduleLevel) {
    if (typeDeclaration(node, container)) return;
    if (valueDeclaration(node, container, moduleLevel)) return;
    ts.forEachChild(node, (c) => visit(c, container, false));
  }

  /** Interfaces, type aliases, enums and namespaces. Returns true when `node` was one of them. */
  function typeDeclaration(/** @type {ts.Node} */ node, /** @type {string[]} */ container) {
    if (ts.isInterfaceDeclaration(node)) members(node.members, add(container, node.name.text, 'interface'));
    else if (ts.isTypeAliasDeclaration(node)) {
      const p = add(container, node.name.text, 'type');
      if (ts.isTypeLiteralNode(node.type)) members(node.type.members, p);
    } else if (ts.isEnumDeclaration(node)) enumMembers(node, add(container, node.name.text, 'enum'));
    else if (ts.isModuleDeclaration(node)) namespace(node, container);
    else return false;
    return true;
  }

  /** Variables, functions, classes and `export default <function>`. Returns true when `node` was one of them. */
  function valueDeclaration(/** @type {ts.Node} */ node, /** @type {string[]} */ container, /** @type {boolean} */ moduleLevel) {
    if (ts.isVariableStatement(node)) variables(node, container, moduleLevel);
    else if (ts.isFunctionDeclaration(node)) {
      const inner = add(container, nameText(node.name, sf) ?? unnamed(node, container), 'function');
      if (node.body) ts.forEachChild(node.body, (c) => visit(c, inner, false));
    } else if (ts.isClassDeclaration(node) || (ts.isClassExpression(node) && node.parent && ts.isExportAssignment(node.parent))) cls(node, container);
    else if (ts.isExportAssignment(node) && !node.isExportEquals && isFunctionValue(node.expression)) {
      const fn = /** @type {ts.ArrowFunction | ts.FunctionExpression} */ (node.expression);
      const p = add(container, nameText(ts.isFunctionExpression(fn) ? fn.name : undefined, sf) ?? 'default', 'function');
      ts.forEachChild(fn.body, (c) => visit(c, p, false));
    } else return false;
    return true;
  }

  /** @param {ts.EnumDeclaration} node @param {string[]} p */
  function enumMembers(node, p) {
    for (const m of node.members) {
      const n = nameText(m.name, sf);
      if (n !== null) add(p, n, 'enum_member');
    }
  }

  /** @param {ts.ModuleDeclaration} node @param {string[]} container */
  function namespace(node, container) {
    if (!ts.isIdentifier(node.name)) return; // `declare module "x"`: not a namespace symbol
    const p = add(container, node.name.text, 'namespace');
    const body = node.body;
    if (body && ts.isModuleBlock(body)) for (const s of body.statements) visit(s, p, true);
    else if (body) visit(body, p, true);
  }

  /** The symbol kind of a module-level variable, or null for a `require(...)` binding (an import, not a symbol). */
  function variableKind(/** @type {ts.Expression | undefined} */ init, /** @type {boolean} */ isConst) {
    if (init !== undefined && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require') return null;
    if (isFunctionValue(init)) return 'function';
    if (init !== undefined && ts.isClassExpression(init)) return 'class';
    return isConst ? 'constant' : 'variable';
  }

  /** @param {ts.VariableStatement} node @param {string[]} container @param {boolean} moduleLevel */
  function variables(node, container, moduleLevel) {
    const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const d of node.declarationList.declarations) {
      const init = d.initializer;
      const kind = moduleLevel && ts.isIdentifier(d.name) ? variableKind(init, isConst) : null;
      if (kind === null || !ts.isIdentifier(d.name)) {
        if (init && !(moduleLevel && ts.isIdentifier(d.name))) visit(init, container, false);
        continue;
      }
      const p = add(container, d.name.text, kind);
      if (init !== undefined && ts.isClassExpression(init)) classMembers(init, p);
      else if (init) visit(init, p, false);
    }
  }

  /** @param {ts.ClassDeclaration | ts.ClassExpression} node @param {string[]} container */
  function cls(node, container) {
    classMembers(node, add(container, nameText(node.name, sf) ?? unnamed(node, container), 'class'));
  }

  /** @param {ts.ClassLikeDeclaration} node @param {string[]} p */
  function classMembers(node, p) {
    for (const m of node.members) {
      if (ts.isConstructorDeclaration(m)) {
        const c = add(p, 'constructor', 'constructor');
        for (const param of m.parameters) {
          const isProperty = (ts.getModifiers(param) ?? []).some((x) => ts.isParameterPropertyModifier(x.kind));
          if (isProperty && ts.isIdentifier(param.name)) add(p, param.name.text, 'property');
        }
        if (m.body) ts.forEachChild(m.body, (x) => visit(x, c, false));
        continue;
      }
      const n = nameText(m.name, sf);
      if (n === null) continue;
      const kind = ts.isMethodDeclaration(m) ? 'method' : ts.isGetAccessorDeclaration(m) ? 'getter' : ts.isSetAccessorDeclaration(m) ? 'setter' : ts.isPropertyDeclaration(m) ? 'property' : null;
      if (kind === null) continue;
      const q = add(p, n, kind);
      ts.forEachChild(m, (x) => (x === m.name ? undefined : visit(x, q, false)));
    }
  }

  /** @param {ts.NodeArray<ts.TypeElement>} list @param {string[]} p */
  function members(list, p) {
    for (const m of list) {
      const n = nameText(m.name, sf);
      if (n === null) continue;
      if (ts.isPropertySignature(m)) add(p, n, 'property');
      else if (ts.isMethodSignature(m)) add(p, n, 'method');
    }
  }

  for (const s of sf.statements) visit(s, [], true);
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Syntax errors tsc reports for a file. `parseDiagnostics` is internal to TypeScript but stable in 6.x. */
const syntaxErrors = (/** @type {ts.SourceFile} */ sf) => (/** @type {{ parseDiagnostics?: unknown[] }} */ (/** @type {unknown} */ (sf)).parseDiagnostics ?? []).length;

/**
 * Oracle symbol ids of every TS/TSX/JS file CIE indexed. Files with syntax errors are reported but left out
 * of the comparison: tsc and tree-sitter recover from errors differently, and neither recovery is "truth".
 */
function oracleSymbols(/** @type {string} */ workspace, /** @type {{path: string, status: string}[]} */ files) {
  const ids = new Set();
  let parsed = 0;
  const undecodable = [];
  const syntaxErrorFiles = [];
  for (const f of files) {
    const spec = LANG_BY_EXT[f.path.slice(f.path.lastIndexOf('.') + 1)];
    if (f.status !== 'indexed' || spec === undefined) continue;
    let text;
    try {
      text = decoder.decode(readFileSync(path.join(workspace, f.path))).replace(/^\uFEFF/, '');
    } catch {
      undecodable.push(f.path);
      continue;
    }
    const sf = ts.createSourceFile(f.path, text, ts.ScriptTarget.Latest, true, spec[1]);
    if (syntaxErrors(sf) > 0) {
      syntaxErrorFiles.push(f.path);
      continue;
    }
    const decls = oracleDeclarations(sf);
    const r = core.identifySymbols(/** @type {never} */ (spec[0]), /** @type {never} */ (f.path), /** @type {never} */ (decls));
    if (!r.ok) throw new Error(`${f.path}: ${r.error.message}`);
    for (const id of r.value) ids.add(id);
    parsed++;
  }
  return { ids, parsed, undecodable, syntaxErrorFiles };
}

// ------------------------------------------------------------------ comparison

const round = (/** @type {number} */ x) => Math.round(x * 10000) / 10000;
const sortU16 = (/** @type {string[]} */ xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const kindOf = (/** @type {string} */ id) => /\(([a-z_]+)\)(?:~\d+)?$/.exec(id)?.[1] ?? '?';

/** Entries listed per missing/extra sample (--sample). */
let SAMPLE = 25;

function compare(/** @type {Iterable<string>} */ actualIds, /** @type {Iterable<string>} */ expectedIds, sample = SAMPLE) {
  const actual = new Set(actualIds);
  const expected = new Set(expectedIds);
  const matched = [...actual].filter((x) => expected.has(x)).length;
  const missing = sortU16([...expected].filter((x) => !actual.has(x)));
  const extra = sortU16([...actual].filter((x) => !expected.has(x)));
  const byKind = (/** @type {string[]} */ xs) => Object.fromEntries(Object.entries(Object.groupBy(xs, kindOf)).map(([k, v]) => [k, v?.length ?? 0]).sort());
  return {
    expected: expected.size,
    actual: actual.size,
    matched,
    precision: actual.size === 0 ? null : round(matched / actual.size),
    recall: expected.size === 0 ? null : round(matched / expected.size),
    missingByKind: byKind(missing),
    extraByKind: byKind(extra),
    missingSample: missing.slice(0, sample),
    extraSample: extra.slice(0, sample),
  };
}

function truthCategories(/** @type {any} */ doc) {
  const nodes = new Map(doc.nodes.map((/** @type {any} */ n) => [n.id, n]));
  const target = (/** @type {string} */ to) => (to.startsWith('unres:') ? `unresolved:${nodes.get(to)?.name ?? '?'}` : to);
  return {
    symbols: doc.nodes.filter((/** @type {any} */ n) => n.kind === 'symbol').map((/** @type {any} */ n) => n.id),
    imports: doc.edges.filter((/** @type {any} */ e) => e.type === 'imports').map((/** @type {any} */ e) => `${e.from} -> ${target(e.to)}`),
    importsSymbol: doc.edges.filter((/** @type {any} */ e) => e.type === 'imports_symbol').map((/** @type {any} */ e) => `${e.from} -> ${e.attrs.name} -> ${target(e.to)}`),
  };
}

function report(/** @type {string} */ id, /** @type {string} */ workspace, /** @type {boolean} */ golden) {
  const { doc, outcome } = exportOf(workspace);
  const oracle = oracleSymbols(workspace, doc.files);
  const excluded = new Set([...oracle.syntaxErrorFiles, ...oracle.undecodable]);
  const cieTsSymbols = doc.nodes
    .filter((/** @type {any} */ n) => n.kind === 'symbol' && ['ts', 'tsx', 'js'].includes(n.language) && !excluded.has(n.file))
    .map((/** @type {any} */ n) => n.id);
  /** @type {Record<string, unknown>} */
  const entry = {
    id,
    golden,
    indexedFiles: doc.files.filter((/** @type {any} */ f) => f.status === 'indexed').length,
    code: outcome.code,
    tsCompiler: {
      parsedFiles: oracle.parsed,
      undecodableFiles: oracle.undecodable,
      syntaxErrorFiles: oracle.syntaxErrorFiles,
      ...compare(cieTsSymbols, oracle.ids),
    },
  };
  if (golden) {
    const truth = JSON.parse(readFileSync(path.join(REPO, 'fixtures', `${id}.truth.json`), 'utf8'));
    const actual = truthCategories(doc);
    entry['groundTruth'] = Object.fromEntries(['symbols', 'imports', 'importsSymbol'].map((c) => [c, compare(actual[/** @type {'symbols'} */ (c)], truth[c])]));
  }
  return entry;
}

function git(/** @type {string[]} */ args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function main() {
  const { values } = parseArgs({ options: { workspace: { type: 'string', multiple: true }, id: { type: 'string', multiple: true }, out: { type: 'string' }, sample: { type: 'string' } } });
  if (values.sample !== undefined) SAMPLE = Number(values.sample);
  const extra = values.workspace ?? [];
  if (extra.length !== (values.id ?? []).length) throw new Error('give one --id per --workspace');
  const entries = GOLDEN.map((g) => report(g, path.join(REPO, 'fixtures', g), true));
  extra.forEach((ws, i) => entries.push(report(/** @type {string} */ ((values.id ?? [])[i]), path.resolve(ws), false)));
  const commit = git(['rev-parse', 'HEAD']);
  const doc = {
    format: 'cie-quality-report/1',
    createdAt: new Date().toISOString(),
    cie: { commit, dirty: (git(['status', '--porcelain']) ?? '') !== '' },
    typescript: ts.version,
    oracleScope: 'module-level declarations; class/interface/type-literal-alias/enum/namespace members incl. parameter properties; function and class declarations at any depth; no locals, parameters or object-literal members',
    entries,
  };
  const out = values.out ?? path.join(REPO, 'benchmarks', 'results', `${doc.createdAt.slice(0, 10)}-${(commit ?? 'nocommit').slice(0, 8)}-quality.json`);
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  for (const e of entries) {
    const t = /** @type {any} */ (e.tsCompiler);
    const g = /** @type {any} */ (e['groundTruth']);
    const truth = g ? ` | truth symbols P ${g.symbols.precision} R ${g.symbols.recall}, imports P ${g.imports.precision} R ${g.imports.recall}, bindings P ${g.importsSymbol.precision} R ${g.importsSymbol.recall}` : '';
    console.log(`${e.id}: tsc symbols ${t.matched}/${t.expected} (P ${t.precision} R ${t.recall})${truth}`);
  }
  console.log(`wrote ${path.relative(REPO, out)}`);
}

main();
