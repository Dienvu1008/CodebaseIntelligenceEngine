// LangTsResolver (P02-06): TypeScript module resolution over the snapshot only, with SY-006 precision.
import { builtinModules } from 'node:module';
import { LangTsResolver, NODE_BUILTINS } from '@cie/adapters';
import { importEdgeViolations } from '@cie/core';
import { describe, expect, it } from 'vitest';
import { edgeSummary, resolveFixture } from '../../../../tests/helpers/workspace-fixture.js';

const resolver = (() => {
  const r = LangTsResolver.create();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

const json = (v: unknown) => JSON.stringify(v, null, 2);

const MONOREPO: Record<string, string> = {
  'package.json': json({ name: 'root', private: true, workspaces: ['packages/*'], devDependencies: { lodash: '4' } }),
  'tsconfig.base.json': json({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' } }),
  'packages/core/package.json': json({ name: '@m/core', type: 'module', exports: { '.': './src/index.ts', './util': './src/util.ts' } }),
  'packages/core/tsconfig.json': json({ extends: '../../tsconfig.base.json', include: ['src'] }),
  'packages/core/src/index.ts': "export function parse(s: string) { return s }\nexport { helper } from './util.js';\n",
  'packages/core/src/util.ts': 'export const helper = 1;\nexport function f(a: string): void;\nexport function f(a) {}\n',
  'packages/app/package.json': json({ name: '@m/app', type: 'module', dependencies: { '@m/core': '*', zod: '3' } }),
  'packages/app/tsconfig.json': json({ extends: '../../tsconfig.base.json', compilerOptions: { baseUrl: '.', paths: { '#lib/*': ['./src/lib/*'], '#gone/*': ['./src/nowhere/*'] } }, include: ['src'] }),
  'packages/app/src/main.ts': [
    "import { parse, helper, missing } from '@m/core';",
    "import { f } from '@m/core/util';",
    "import '@m/core/nope';",
    "import { z } from 'zod';",
    "import _ from 'lodash';",
    "import left from 'left-pad';",
    "import { readFile } from 'node:fs/promises';",
    "import path from 'path';",
    "import { local } from './local.js';",
    "import { thing } from '#lib/thing.js';",
    "import '#gone/x.js';",
    "import data from './data.json';",
    "import './missing.js';",
    'const m = await import(name);',
    '',
  ].join('\n'),
  'packages/app/src/local.ts': 'export const local = 1;\n',
  'packages/app/src/lib/thing.ts': 'export class thing {}\n',
  'packages/app/src/data.json': '{}',
  'scripts/tool.js': "const fs = require('fs');\nconst cfg = require('../packages/app/src/local');\n",
};

describe('LangTsResolver on a monorepo', () => {
  it('resolves workspace packages (exports), paths, relative files, externals and built-ins with honest precision', async () => {
    const { resolution } = await resolveFixture(MONOREPO, resolver);
    const fromMain = edgeSummary(resolution.edges.filter((e) => e.from === 'mod:ts:packages/app/src/main.ts'));
    expect(fromMain).toEqual([
      'mod:ts:packages/app/src/main.ts -> mod:ts:packages/core/src/index.ts [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> ts:packages/core/src/index.ts#parse(function) [imports_symbol inferred heuristic] parse',
      // `helper` is a re-export and `missing` does not exist: neither is guessed.
      expect.stringMatching(/^mod:ts:packages\/app\/src\/main\.ts -> unres:ts:packages\/app\/src\/main\.ts#[0-9a-f]{16} \[imports_symbol unknown\] helper$/),
      expect.stringMatching(/ -> unres:ts:.* \[imports_symbol unknown\] missing$/),
      'mod:ts:packages/app/src/main.ts -> mod:ts:packages/core/src/util.ts [imports verified exact]',
      // Overloads give two candidates (f~1, f~2): not guessed either.
      expect.stringMatching(/ -> unres:ts:.* \[imports_symbol unknown\] f$/),
      expect.stringMatching(/ -> unres:ts:.* \[imports unknown\]$/), // @m/core/nope: not in exports
      'mod:ts:packages/app/src/main.ts -> ext:npm:zod [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> ext:npm:lodash [imports verified exact]', // declared in the root package.json
      'mod:ts:packages/app/src/main.ts -> ext:npm:left-pad [imports inferred heuristic]', // undeclared
      'mod:ts:packages/app/src/main.ts -> ext:node:fs/promises [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> ext:node:path [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> mod:ts:packages/app/src/local.ts [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> ts:packages/app/src/local.ts#local(constant) [imports_symbol inferred heuristic] local',
      'mod:ts:packages/app/src/main.ts -> mod:ts:packages/app/src/lib/thing.ts [imports verified exact]',
      'mod:ts:packages/app/src/main.ts -> ts:packages/app/src/lib/thing.ts#thing(class) [imports_symbol inferred heuristic] thing',
      expect.stringMatching(/ -> unres:ts:.* \[imports unknown\]$/), // #gone/*: paths target missing
      expect.stringMatching(/ -> unres:ts:.* \[imports unknown\]$/), // ./missing.js
      expect.stringMatching(/ -> unres:ts:.* \[imports unknown\]$/), // import(name)
    ]);
    expect(resolution.diagnostics.map((d) => [d.code, d.path])).toEqual([['IMPORT_TARGET_NOT_A_MODULE', 'packages/app/src/main.ts']]);
  });

  it('resolves CommonJS requires in files outside every tsconfig through the inferred project', async () => {
    const { resolution } = await resolveFixture(MONOREPO, resolver);
    expect(edgeSummary(resolution.edges.filter((e) => e.from === 'mod:js:scripts/tool.js'))).toEqual([
      'mod:js:scripts/tool.js -> ext:node:fs [imports verified exact]',
      'mod:js:scripts/tool.js -> mod:ts:packages/app/src/local.ts [imports verified exact]',
    ]);
    expect(resolution.projects).toEqual([
      { kind: 'tsconfig', language: 'ts', config: 'packages/app/tsconfig.json', root: 'packages/app' },
      { kind: 'tsconfig', language: 'ts', config: 'packages/core/tsconfig.json', root: 'packages/core' },
      { kind: 'inferred', language: 'ts', config: null, root: null },
    ]);
  });

  it('is deterministic and never overstates precision (SY-006)', async () => {
    const a = await resolveFixture(MONOREPO, resolver);
    const b = await resolveFixture(MONOREPO, resolver);
    expect(b.resolution).toEqual(a.resolution);
    expect(a.resolution.edges.flatMap(importEdgeViolations)).toEqual([]);
    expect(new Set(a.resolution.edges.map((e) => e.producer.adapterId))).toEqual(new Set(['lang-ts']));
    expect(a.resolution.edges[0]?.producer).toEqual({ adapterId: 'lang-ts', adapterVersion: '0.1.0', toolVersion: 'typescript@6.0.3', fidelity: 'L3' });
  });
});

describe('LangTsResolver configuration handling', () => {
  it('reports broken tsconfig files and keeps resolving with what parsed', async () => {
    const { resolution } = await resolveFixture(
      {
        'tsconfig.json': '{ "compilerOptions": { "moduleResolution": "nonsense" }, "extends": "./missing.json" }',
        'src/a.ts': "import { b } from './b';\n",
        'src/b.ts': 'export const b = 1;\n',
      },
      resolver,
    );
    expect(resolution.diagnostics.filter((d) => d.code === 'TSCONFIG_ERROR').length).toBeGreaterThan(0);
    expect(edgeSummary(resolution.edges)[0]).toBe('mod:ts:src/a.ts -> mod:ts:src/b.ts [imports verified exact]');
  });

  it('flags duplicate workspace package names', async () => {
    const { resolution } = await resolveFixture({ 'a/package.json': json({ name: 'dup' }), 'b/package.json': json({ name: 'dup' }), 'x.ts': "import 'dup';\n" }, resolver);
    expect(resolution.diagnostics.map((d) => [d.code, d.path])).toEqual([['DUPLICATE_PACKAGE_NAME', 'b/package.json']]);
  });

  it('keeps a fixed list of Node built-ins that the running Node still provides', () => {
    for (const b of NODE_BUILTINS) expect(builtinModules, b).toContain(b);
  });
});
