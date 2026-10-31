/**
 * PathCanonicalizer (WS-002, lexical part). Turns a raw workspace-relative path into a CanonicalPath, or
 * rejects it. Realpath / symlink confinement is the FileSystem adapter's job (WS-002 b/c).
 *
 * Policy decisions (recorded in PHASE_01_SIGNOFF):
 *  - '\' is treated as a separator on every OS. This keeps manifests identical across Windows and Linux
 *    (WS-004). A Linux file whose name contains '\' is therefore not representable and gets skipped.
 *  - Names that are not portable to Windows (reserved device names, `<>:"|?*`, trailing '.' or ' ') are
 *    rejected as PATH_NON_PORTABLE on every OS, for the same determinism reason. The enumerator records
 *    them as skipped files with a reason; they are never silently mapped to another name.
 *  - '.' and empty segments are dropped. '..' is resolved lexically and must not climb above the root.
 *  - Every segment is NFC-normalized. Case is preserved.
 */
import type { CanonicalPath, DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';

export type PathErrorCode =
  | 'PATH_EMPTY'
  | 'PATH_ABSOLUTE'
  | 'PATH_ESCAPES_ROOT'
  | 'PATH_INVALID_CHAR'
  | 'PATH_NON_PORTABLE';

// Control characters (C0 + DEL) and unpaired UTF-16 surrogates cannot appear in a canonical path.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const NON_PORTABLE_CHAR = /[<>:"|?*]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

function fail(code: PathErrorCode, message: string, raw: string): Result<never, DomainError> {
  return err(domainError(code, message, { path: raw }));
}

function nonPortableReason(segment: string): string | null {
  if (NON_PORTABLE_CHAR.test(segment)) return 'contains one of <>:"|?* (Windows-reserved; ":" also marks NTFS streams)';
  if (RESERVED_NAME.test(segment)) return 'is a Windows reserved device name';
  if (TRAILING_DOT_OR_SPACE.test(segment)) return 'ends with "." or " ", which Windows strips (aliasing)';
  return null;
}

export function canonicalizePath(raw: string): Result<CanonicalPath, DomainError> {
  if (raw === '') return fail('PATH_EMPTY', 'path is empty', raw);
  if (CONTROL_CHARS.test(raw) || LONE_SURROGATE.test(raw)) {
    return fail('PATH_INVALID_CHAR', 'path contains a control character or an unpaired surrogate', raw);
  }
  const slashed = raw.replace(/\\/g, '/');
  // Covers POSIX absolute paths, UNC (//server) and Win32 device paths (\\?\, \\.\).
  if (slashed.startsWith('/')) return fail('PATH_ABSOLUTE', 'path must be workspace-relative', raw);
  // Covers C:\x, C:/x and drive-relative C:x.
  if (DRIVE_PREFIX.test(slashed)) return fail('PATH_ABSOLUTE', 'path must not carry a drive prefix', raw);

  const segments: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return fail('PATH_ESCAPES_ROOT', 'path climbs above the workspace root', raw);
      segments.pop();
      continue;
    }
    const normalized = segment.normalize('NFC');
    const reason = nonPortableReason(normalized);
    if (reason !== null) return fail('PATH_NON_PORTABLE', `segment "${normalized}" ${reason}`, raw);
    segments.push(normalized);
  }
  if (segments.length === 0) return fail('PATH_EMPTY', 'path refers to the workspace root itself', raw);
  return ok(segments.join('/') as CanonicalPath);
}

/**
 * Deterministic ordering of canonical paths by UTF-16 code units. Never use localeCompare: it depends
 * on the machine's locale and ICU version (WS-004).
 */
export function compareCanonicalPaths(a: CanonicalPath, b: CanonicalPath): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
