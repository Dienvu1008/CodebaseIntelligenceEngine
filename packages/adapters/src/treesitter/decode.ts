/**
 * Source decoding (CODE_INTELLIGENCE_STRATEGY §6.1). UTF-8 is expected. A UTF-16 BOM selects UTF-16LE/BE.
 * The BOM is not part of the decoded text, so ranges and span hashes never include it. Invalid input is
 * rejected (EXTRACTION_UNDECODABLE) instead of being replaced with U+FFFD: a replacement would change
 * the text that span hashes are computed over.
 */
import { domainError, err, ok, type DomainError, type Result } from '@cie/core';

export type SourceEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

function detect(bytes: Uint8Array): { encoding: SourceEncoding; offset: number } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', offset: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', offset: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', offset: 2 };
  return { encoding: 'utf-8', offset: 0 };
}

export function decodeSource(bytes: Uint8Array): Result<{ readonly text: string; readonly encoding: SourceEncoding }, DomainError> {
  const { encoding, offset } = detect(bytes);
  try {
    // ignoreBOM: the BOM was already skipped above; a second one is content.
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
    return ok({ text, encoding });
  } catch {
    return err(domainError('EXTRACTION_UNDECODABLE', `content is not valid ${encoding}`, { encoding }));
  }
}
