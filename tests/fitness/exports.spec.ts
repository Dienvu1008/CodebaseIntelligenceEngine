// FF-BND-007: package exports maps expose only the public entry point. Deep imports must not resolve.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';

const require = createRequire(repoPath('package.json'));
const PACKAGES = ['@cie/protocol', '@cie/core', '@cie/adapters', '@cie/runtime'] as const;

function resolveError(specifier: string): string | undefined {
  try {
    require.resolve(specifier);
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
}

describe.each(PACKAGES)('%s exports map', (pkg) => {
  it('resolves the public entry point', () => {
    expect(resolveError(pkg)).toBeUndefined();
  });
  it.each(['src/index.ts', 'dist/index.js', 'tsconfig.json'])('blocks the deep import %s', (sub) => {
    expect(resolveError(`${pkg}/${sub}`)).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});

describe('@cie/core deep imports into contexts', () => {
  it.each(['dist/shared-kernel/ids.js', 'dist/workspace/application/ports.js'])('blocks %s', (sub) => {
    expect(resolveError(`@cie/core/${sub}`)).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
