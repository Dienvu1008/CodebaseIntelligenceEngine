/**
 * Source decoding for Programs. It must produce exactly the text the tree-sitter extractor parsed
 * (adapters/treesitter/decode.ts): import ranges are offsets into that text. Adapter folders are independent
 * (DEPENDENCY_RULES A1), so the rule is restated here and a test asserts both decoders agree byte for byte.
 */
export function decodeSourceText(bytes: Uint8Array): string | null {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, offset] = ['utf-16le', 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, offset] = ['utf-16be', 2];
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
  } catch {
    return null;
  }
}
