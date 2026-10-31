// Unit tests for IgnoreEvaluator behavior that git cannot act as an oracle for: CIE's layers,
// explanations, case sensitivity and robustness against malformed patterns.
import { canonicalizePath, CIE_DEFAULT_IGNORES, IgnoreEvaluator, type CanonicalPath, type IgnoreSource } from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const p = (raw: string): CanonicalPath => {
  const r = canonicalizePath(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
};
const src = (layer: IgnoreSource['layer'], text: string, base: string | null = null): IgnoreSource => ({
  layer,
  text,
  base: base === null ? null : p(base),
  origin: `${layer}:${base ?? '/'}`,
});

describe('CIE layers', () => {
  it('ignores CIE defaults (node_modules, .git, .cie, dist, __pycache__, *.pyc)', () => {
    const ev = IgnoreEvaluator.from([src('default', CIE_DEFAULT_IGNORES)]);
    for (const [path, kind] of [
      ['node_modules', 'directory'],
      ['packages/x/node_modules', 'directory'],
      ['.git', 'directory'],
      ['.cie', 'directory'],
      ['dist', 'directory'],
      ['pkg/__pycache__', 'directory'],
      ['pkg/mod.pyc', 'file'],
      ['tsconfig.tsbuildinfo', 'file'],
    ] as const) {
      expect(ev.isIgnored(p(path), kind), path).toBe(true);
    }
    expect(ev.isIgnored(p('src/index.ts'), 'file')).toBe(false);
    expect(ev.isIgnored(p('dist'), 'file')).toBe(false); // a *file* named dist is not a dist/ directory
  });

  it('lets a .gitignore negation re-include a CIE default', () => {
    const ev = IgnoreEvaluator.from([src('default', CIE_DEFAULT_IGNORES), src('gitignore', '!dist/')]);
    expect(ev.isIgnored(p('dist'), 'directory')).toBe(false);
  });

  it('gives cie.config.json ignore rules the last word over .gitignore negations', () => {
    const ev = IgnoreEvaluator.from([src('config', 'generated/'), src('gitignore', '!generated/')]);
    expect(ev.isIgnored(p('generated'), 'directory')).toBe(true);
  });

  it('lets a deeper .gitignore override a shallower one regardless of input order', () => {
    const ev = IgnoreEvaluator.from([src('gitignore', '!keep.log', 'pkg'), src('gitignore', '*.log')]);
    expect(ev.isIgnored(p('pkg/keep.log'), 'file')).toBe(false);
    expect(ev.isIgnored(p('other/keep.log'), 'file')).toBe(true);
  });

  it('applies nested patterns only below their own directory', () => {
    const ev = IgnoreEvaluator.from([src('gitignore', '/local.txt', 'pkg')]);
    expect(ev.isIgnored(p('pkg/local.txt'), 'file')).toBe(true);
    expect(ev.isIgnored(p('local.txt'), 'file')).toBe(false);
    expect(ev.isIgnored(p('pkg/sub/local.txt'), 'file')).toBe(false);
  });
});

describe('explanations', () => {
  it('reports the deciding rule and the ignored ancestor', () => {
    const ev = IgnoreEvaluator.from([src('gitignore', 'build/\n!build/keep.txt')]);
    const d = ev.explain(p('build/keep.txt'), 'file');
    expect(d.ignored).toBe(true);
    expect(d.ignoredAncestor).toBe('build');
    expect(d.rule?.pattern).toBe('build/');
  });

  it('reports a negation as the deciding rule when a path is re-included', () => {
    const ev = IgnoreEvaluator.from([src('gitignore', '*.log\n!keep.log')]);
    const d = ev.explain(p('keep.log'), 'file');
    expect(d).toMatchObject({ ignored: false, ignoredAncestor: null, rule: { pattern: '!keep.log', line: 2, negated: true } });
  });
});

describe('determinism and robustness', () => {
  it('matches case-sensitively on every OS', () => {
    const ev = IgnoreEvaluator.from([src('gitignore', 'readme.md')]);
    expect(ev.isIgnored(p('README.md'), 'file')).toBe(false);
    expect(ev.isIgnored(p('readme.md'), 'file')).toBe(true);
  });

  it('never throws on arbitrary pattern text, and malformed patterns never match (property)', () => {
    const patternChars = fc.constantFrom('*', '?', '[', ']', '!', '^', '-', '\\', '/', ':', 'a', 'z', '0', ' ', '#', '\r');
    const patterns = fc.array(fc.array(patternChars, { maxLength: 12 }).map((c) => c.join('')), { maxLength: 6 });
    fc.assert(
      fc.property(patterns, (lines) => {
        const ev = IgnoreEvaluator.from([src('gitignore', lines.join('\n'))]);
        expect(typeof ev.isIgnored(p('a/z0.txt'), 'file')).toBe('boolean');
      }),
      { seed: 20261031, numRuns: 1000 },
    );
    expect(IgnoreEvaluator.from([src('gitignore', 'abc\\')]).isIgnored(p('abc'), 'file')).toBe(false);
    expect(IgnoreEvaluator.from([src('gitignore', '[z-a]')]).isIgnored(p('m'), 'file')).toBe(false);
  });
});
