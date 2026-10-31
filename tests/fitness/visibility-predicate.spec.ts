// FF-BND-003: raw SQL stays in adapters/sqlite, and the revision-visibility predicate has exactly one source
// (visibleAt in index-store.ts). A second hand-written copy is exactly how interval bugs creep in (R-13).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'dist' || name === 'node_modules' ? [] : sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const files = readdirSync(repoPath('packages')).flatMap((p) => {
  try {
    return sourceFiles(repoPath(`packages/${p}/src`));
  } catch {
    return [];
  }
});
const rel = (f: string) => path.relative(repoPath('.'), f).split(path.sep).join('/');

describe('FF-BND-003: SQL and visibility', () => {
  it('writes the validity-interval predicate in exactly one place', () => {
    const hits = files.filter((f) => /valid_from_seq\s*<=/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(hits).toEqual(['packages/adapters/src/sqlite/index-store.ts']);
  });

  it('keeps SQL statements inside adapters/sqlite', () => {
    const SQL = /\b(select\s+[\w*.,\s]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table)\b/i;
    const offenders = files.filter((f) => !rel(f).startsWith('packages/adapters/src/sqlite/') && SQL.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });
});
