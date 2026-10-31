// Lives in tests/oracles (not packages/core/test) because it spawns git, and packages/ may not use
// child_process (FF-DEP-007).
// Oracle test for IgnoreEvaluator (P01-03). On a real fixture tree, the set of non-ignored files that CIE
// computes must equal exactly what git computes with `git ls-files --others --exclude-standard`.
// git runs with core.ignorecase=false (CIE matches case-sensitively on every OS) and with no
// core.excludesFile (CIE does not read machine-local excludes). See ignore-evaluator.ts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalizePath, IgnoreEvaluator, type CanonicalPath } from '@cie/core';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT_GITIGNORE = [
  '# comment line',
  '',
  '*.log',
  '!keep.log',
  '/root-only.txt',
  'build/',
  'docs/**/draft-*.md',
  '**/gen/*.ts',
  '!**/gen/keep.ts',
  'tmp*',
  '\\#hash.txt',
  '\\!bang.txt',
  'trailing.txt   ',
  'a/**/z.txt',
  'data/*',
  '!data/keep/',
  '[Tt]humbs.db',
  'file[0-9].txt',
  'file[!0-9]x.txt',
  'caf*',
  'excluded-dir/',
  '!excluded-dir/inner.txt',
  'star/*',
  '!star/inner.txt',
  'readme.md',
  'vendor/**',
  '!vendor/keep/',
  '!vendor/keep/**',
  'class[[:digit:]].txt',
  'q?.txt',
  'deep/**',
  '!deep/**/',
  '!deep/**/*.md',
].join('\n');

const NESTED_GITIGNORE = ['*.tmp', '!important.log', '/local-only.txt', 'sub2/'].join('\n');

const files: Record<string, string> = {
  '.gitignore': ROOT_GITIGNORE,
  'app.log': '',
  'keep.log': '',
  'sub/x.log': '',
  'sub/keep.log': '',
  'root-only.txt': '',
  'sub/root-only.txt': '',
  'build/out.js': '',
  'src/build/out.js': '',
  'src/index.ts': '',
  'docs/a/b/draft-1.md': '',
  'docs/draft-2.md': '',
  'docs/final.md': '',
  'src/gen/a.ts': '',
  'src/gen/keep.ts': '',
  'gen/b.ts': '',
  'gen/b.js': '',
  'tmp.txt': '',
  'tmpdir/x.txt': '',
  '#hash.txt': '',
  '!bang.txt': '',
  'trailing.txt': '',
  'a/z.txt': '',
  'a/b/c/z.txt': '',
  'a/y.txt': '',
  'data/x.txt': '',
  'data/keep/y.txt': '',
  'data/other/z.txt': '',
  'Thumbs.db': '',
  'file1.txt': '',
  'filex.txt': '',
  'fileax.txt': '',
  'file1x.txt': '',
  'caf\u00e9.txt': '',
  'excluded-dir/inner.txt': '',
  'excluded-dir/other.txt': '',
  'star/inner.txt': '',
  'star/other.txt': '',
  'README.md': '',
  'vendor/v.txt': '',
  'vendor/keep/k.txt': '',
  'class1.txt': '',
  'classx.txt': '',
  'q1.txt': '',
  'q12.txt': '',
  'deep/x/y.txt': '',
  'deep/x/y.md': '',
  'nested/.gitignore': NESTED_GITIGNORE,
  'nested/a.tmp': '',
  'nested/important.log': '',
  'nested/other.log': '',
  'nested/local-only.txt': '',
  'nested/deep2/local-only.txt': '',
  'nested/sub2/x.txt': '',
  'nested/deep2/sub2/y.txt': '',
  'nested/keep.ts': '',
  'crlfdir/.gitignore': 'crlf.txt\r\n!crlf-keep.txt\r\n',
  'crlfdir/crlf.txt': '',
  'crlfdir/crlf-keep.txt': '',
};

const repo = mkdtempSync(path.join(tmpdir(), 'cie-ignore-oracle-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(repo, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function gitUnignored(): string[] {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const out = execFileSync(
    'git',
    [
      '-c', 'core.ignorecase=false',
      '-c', `core.excludesFile=${path.join(repo, 'no-such-excludes-file')}`,
      'ls-files', '--others', '--exclude-standard', '-z',
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  return out.split('\0').filter((p) => p !== '').map((p) => p.normalize('NFC')).sort();
}

function canonical(rel: string): CanonicalPath {
  const r = canonicalizePath(rel);
  if (!r.ok) throw new Error(`fixture path rejected: ${rel}`);
  return r.value;
}

/** Top-down walk like git's: skip ignored directories, load each .gitignore on entering its directory. */
function cieUnignored(): string[] {
  const result: string[] = [];
  const walk = (dirRel: string, evaluator: IgnoreEvaluator): void => {
    const dirAbs = path.join(repo, ...dirRel.split('/').filter(Boolean));
    let ev = evaluator;
    const gitignore = path.join(dirAbs, '.gitignore');
    try {
      ev = ev.with({
        layer: 'gitignore',
        base: dirRel === '' ? null : canonical(dirRel),
        text: readFileSync(gitignore, 'utf8'),
        origin: `${dirRel === '' ? '' : `${dirRel}/`}.gitignore`,
      });
    } catch {
      // no .gitignore in this directory
    }
    for (const name of readdirSync(dirAbs).sort()) {
      if (dirRel === '' && name === '.git') continue;
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      const isDir = statSync(path.join(dirAbs, name)).isDirectory();
      if (ev.isIgnored(canonical(rel), isDir ? 'directory' : 'file')) continue;
      if (isDir) walk(rel, ev);
      else result.push(rel.normalize('NFC'));
    }
  };
  walk('', IgnoreEvaluator.from([]));
  return result.sort();
}

/**
 * Point queries: one evaluator loaded with EVERY .gitignore in the fixture, asked about each file
 * directly, with no walker skipping ignored directories. This exercises the "cannot re-include a path
 * whose parent directory is excluded" rule, which the walk above never reaches.
 */
function ciePointQueryUnignored(): string[] {
  const sources = Object.entries(files)
    .filter(([rel]) => rel === '.gitignore' || rel.endsWith('/.gitignore'))
    .map(([rel, text]) => {
      const dir = rel.slice(0, -'.gitignore'.length).replace(/\/$/, '');
      return { layer: 'gitignore' as const, base: dir === '' ? null : canonical(dir), text, origin: rel };
    });
  const ev = IgnoreEvaluator.from(sources);
  return Object.keys(files)
    .filter((rel) => !ev.isIgnored(canonical(rel), 'file'))
    .map((rel) => rel.normalize('NFC'))
    .sort();
}

describe('IgnoreEvaluator vs git (oracle)', () => {
  const expected = gitUnignored();

  it('exercises both outcomes (fixture sanity)', () => {
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.length).toBeLessThan(Object.keys(files).length);
  });

  it('walk: computes exactly the non-ignored files of git ls-files --others --exclude-standard', () => {
    expect(cieUnignored()).toEqual(expected);
  });

  it('point queries: agrees with git for every file, including files under excluded directories', () => {
    expect(ciePointQueryUnignored()).toEqual(expected);
  });
});
