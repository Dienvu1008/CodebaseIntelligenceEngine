// PythonImportResolver (P02-07): lookup order, roots, relative imports and classification edge cases.
// The fixtures py-basic and py-src-layout are pinned by tests/golden/python-imports.spec.ts.
import { PythonImportResolver } from '@cie/adapters';
import { importEdgeViolations } from '@cie/core';
import { describe, expect, it } from 'vitest';
import { edgeSummary, resolveFixture } from '../../../../tests/helpers/workspace-fixture.js';

const resolver = (() => {
  const r = PythonImportResolver.create();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

async function edgesOf(files: Record<string, string>, from: string): Promise<string[]> {
  const { resolution } = await resolveFixture(files, resolver);
  expect(resolution.edges.flatMap(importEdgeViolations)).toEqual([]);
  return edgeSummary(resolution.edges.filter((e) => e.from === `mod:py:${from}`)).map((s) => s.replace(`mod:py:${from} -> `, '').replace(/#[0-9a-f]{16}/, '#…'));
}

describe('PythonImportResolver lookup', () => {
  it('prefers a package over a module, and a .py over a .pyi stub', async () => {
    expect(await edgesOf({ 'm.py': 'import a\nimport b\n', 'a/__init__.py': '', 'a.py': '', 'b.py': '', 'b.pyi': '' }, 'm.py')).toEqual([
      'mod:py:a/__init__.py [imports inferred heuristic]',
      'mod:py:b.py [imports inferred heuristic]',
    ]);
    expect(await edgesOf({ 'm.py': 'import c\n', 'c.pyi': '' }, 'm.py')).toEqual(['mod:py:c.pyi [imports inferred heuristic]']);
  });

  it('lets a local module shadow the standard library, as the script directory does on sys.path', async () => {
    expect(await edgesOf({ 'm.py': 'import logging\nimport os\n', 'logging.py': '' }, 'm.py')).toEqual([
      'mod:py:logging.py [imports inferred heuristic]',
      'ext:python:os [imports inferred heuristic]',
    ]);
  });

  it('searches the roots that contain the importing file first (multi-project monorepo)', async () => {
    const files = {
      'svc-a/pyproject.toml': '',
      'svc-a/src/common/__init__.py': '',
      'svc-a/src/app.py': 'import common\n',
      'svc-b/pyproject.toml': '',
      'svc-b/src/common/__init__.py': '',
      'svc-b/src/app.py': 'import common\n',
    };
    expect(await edgesOf(files, 'svc-a/src/app.py')).toEqual(['mod:py:svc-a/src/common/__init__.py [imports inferred heuristic]']);
    expect(await edgesOf(files, 'svc-b/src/app.py')).toEqual(['mod:py:svc-b/src/common/__init__.py [imports inferred heuristic]']);
  });

  it('treats a namespace package without a module file as unresolved, not as a third-party package', async () => {
    expect(await edgesOf({ 'm.py': 'import ns\nimport ns.mod\n', 'ns/mod.py': '' }, 'm.py')).toEqual([
      'unres:py:m.py#… [imports unknown]',
      'mod:py:ns/mod.py [imports inferred heuristic]',
    ]);
  });
});

describe('PythonImportResolver relative imports and names', () => {
  const files = {
    'pkg/__init__.py': 'VALUE = 1\ndef twice(): pass\ndef twice(): pass\n',
    'pkg/a.py': 'from . import b, VALUE, twice, nope\nfrom .. import top\nfrom .missing import x\n',
    'pkg/b.py': '',
  };

  it('resolves submodules, single symbols, and leaves ambiguous or missing names and impossible climbs unresolved', async () => {
    expect(await edgesOf(files, 'pkg/a.py')).toEqual([
      'mod:py:pkg/__init__.py [imports inferred heuristic]',
      'mod:py:pkg/b.py [imports inferred heuristic]',
      'py:pkg/__init__.py#VALUE(variable) [imports_symbol inferred heuristic] VALUE',
      'unres:py:pkg/a.py#… [imports_symbol unknown] twice', // redeclared: two candidates
      'unres:py:pkg/a.py#… [imports_symbol unknown] nope',
      'unres:py:pkg/a.py#… [imports unknown]', // `..` from pkg/ climbs to the root, which is not a package
      'unres:py:pkg/a.py#… [imports unknown]', // .missing
    ]);
  });

  it('declares imports at L2: nothing is exact, and the producer says so', async () => {
    const { resolution } = await resolveFixture(files, resolver);
    expect(resolution.edges.every((e) => e.precision !== 'exact' && e.producer.fidelity === 'L2')).toBe(true);
    expect(resolver.profiles[0]?.fidelity).toMatchObject({ imports: 'L2', symbols: 'L0' });
  });
});
