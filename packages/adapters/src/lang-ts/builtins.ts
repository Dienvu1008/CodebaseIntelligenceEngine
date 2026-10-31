/**
 * Node.js built-in modules importable without the `node:` prefix. This is a fixed snapshot (Node 24), not
 * `module.builtinModules`: the runtime list differs between Node versions, and resolution output must not
 * depend on which Node runs the indexer (WS-004). Any `node:`-prefixed specifier is a built-in.
 * A test checks that every entry is still a built-in on the running Node.
 */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/** The built-in module name for a specifier (`node:fs/promises` → `fs/promises`), or null. */
export function builtinName(specifier: string): string | null {
  if (specifier.startsWith('node:')) return specifier.length > 5 ? specifier.slice(5) : null;
  return NODE_BUILTINS.has(specifier) ? specifier : null;
}

/** npm package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`), or null. */
export function packageNameOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:/.test(specifier)) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[1] !== '' ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] === '' ? null : (parts[0] as string);
}
