// lang-ts decodes source texts for Programs with its own copy of the decoding rules (adapter folders are
// independent, DEPENDENCY_RULES A1). Import ranges are offsets into the text the tree-sitter extractor parsed,
// so the two decoders must agree exactly on every input, including BOMs and invalid bytes.
import { decodeSource } from '@cie/adapters';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeSourceText } from '../../src/lang-ts/decode.js';

const reference = (bytes: Uint8Array): string | null => {
  const r = decodeSource(bytes);
  return r.ok ? r.value.text : null;
};

describe('lang-ts decodeSourceText agrees with the tree-sitter decoder', () => {
  it.each([
    ['plain UTF-8', [0x61, 0x0a, 0x62]],
    ['UTF-8 BOM', [0xef, 0xbb, 0xbf, 0x61]],
    ['double BOM (the second is content)', [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]],
    ['UTF-16LE BOM', [0xff, 0xfe, 0x61, 0x00]],
    ['UTF-16BE BOM', [0xfe, 0xff, 0x00, 0x61]],
    ['invalid UTF-8', [0x61, 0xff, 0x62]],
    ['odd-length UTF-16', [0xff, 0xfe, 0x61]],
    ['empty', []],
  ])('%s', (_label, bytes) => {
    const b = new Uint8Array(bytes);
    expect(decodeSourceText(b)).toBe(reference(b));
  });

  it('on arbitrary bytes (property-based)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.constantFrom([], [0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff]), (body, bom) => {
        const b = new Uint8Array([...bom, ...body]);
        expect(decodeSourceText(b)).toBe(reference(b));
      }),
    );
  });
});
