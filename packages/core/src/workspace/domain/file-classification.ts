/**
 * File classification used by enumeration: binary detection and the Phase 01 language tag.
 *
 * The language tag is a provisional extension map. In Phase 02, the code-intelligence LanguageRegistry
 * becomes the authority and this map must agree with it (a golden test is added then).
 */
import type { CanonicalPath } from '../../shared-kernel/index.js';

/** Like git's heuristic: a NUL byte within the first 8000 bytes means binary. */
export const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(content: Uint8Array): boolean {
  const n = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (content[i] === 0) return true;
  return false;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  py: 'py',
  pyi: 'py',
};

/** Adapter language id for a path, or null when no MVP adapter claims it. Case-sensitive, like the rest of CIE. */
export function languageForPath(path: CanonicalPath): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/** Expected sequence length for a UTF-8 lead byte, or 0 if the byte cannot start a sequence. */
function sequenceLength(b0: number): number {
  if (b0 < 0x80) return 1;
  if (b0 >= 0xc2 && b0 < 0xe0) return 2;
  if (b0 >= 0xe0 && b0 < 0xf0) return 3;
  if (b0 >= 0xf0 && b0 < 0xf5) return 4;
  return 0;
}

const MIN_CODE_POINT = [0, 0, 0x80, 0x800, 0x10000] as const;

/** Decodes one sequence starting at bytes[i]. Returns null for malformed, overlong or surrogate sequences. */
function decodeSequence(bytes: Uint8Array, i: number, len: number): number | null {
  if (i + len > bytes.length) return null;
  let v = (bytes[i] as number) & (0xff >> (len + 1));
  for (let k = 1; k < len; k++) {
    const b = bytes[i + k] as number;
    if ((b & 0xc0) !== 0x80) return null;
    v = (v << 6) | (b & 0x3f);
  }
  const tooSmall = v < (MIN_CODE_POINT[len as 2 | 3 | 4] ?? 0);
  return tooSmall || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) ? null : v;
}

/**
 * Minimal UTF-8 decoder (the core compiles without TextDecoder). An invalid sequence becomes one U+FFFD and
 * decoding resumes at the next byte. Used for small text files that CIE itself interprets, such as .gitignore.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const len = sequenceLength(bytes[i] as number);
    const cp = len === 1 ? (bytes[i] as number) : len === 0 ? null : decodeSequence(bytes, i, len);
    if (cp === null) {
      out += '\ufffd';
      i += 1;
    } else {
      out += String.fromCodePoint(cp);
      i += len;
    }
  }
  return out;
}
