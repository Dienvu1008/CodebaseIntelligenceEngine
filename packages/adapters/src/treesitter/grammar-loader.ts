/**
 * Loads the vendored tree-sitter grammars (ADR-0010, OQ-09 option A).
 *
 * The .wasm artifacts and grammars.lock.json live in packages/adapters/grammars/ and are produced by
 * scripts/grammars/fetch.mjs. Integrity is checked once per grammar per loader, at first load:
 *   1. read the artifact bytes;
 *   2. compare byte size and SHA-256 with the lock entry (GRAMMAR_INTEGRITY_MISMATCH on any difference);
 *   3. hand those same verified bytes to Language.load (no second read, so nothing can swap the file
 *      between verification and use);
 *   4. compare the loaded ABI version with the lock.
 * The resulting Language is cached for the loader's lifetime; `defaultGrammarLoader()` is the process-wide
 * instance, so the parsing hot path never hashes an artifact again. A failed load is not cached, so a later
 * call retries (for instance after a transient read error).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainError, err, type DomainError, type Hasher, type Result } from '@cie/core';
import { Language, Parser } from 'web-tree-sitter';
import { NodeHasher } from '../fs/system.js';

/** Same depth from src/treesitter/ (tests) and dist/treesitter/ (runtime): both resolve to packages/adapters/grammars/. */
export const VENDORED_GRAMMARS_DIR = fileURLToPath(new URL('../../grammars/', import.meta.url));
export const GRAMMAR_LOCK_FILE = 'grammars.lock.json';
export const GRAMMAR_LOCK_FORMAT = 'cie-grammars/1';

export interface GrammarLockEntry {
  readonly language: string;
  readonly abi: number;
  readonly source: { readonly package: string; readonly version: string; readonly tarball: string; readonly integrity: string };
  readonly artifact: { readonly file: string; readonly sha256: string; readonly bytes: number };
  readonly license: { readonly spdx: string; readonly file: string; readonly sha256: string };
}

export interface GrammarLock {
  readonly format: typeof GRAMMAR_LOCK_FORMAT;
  readonly runtime: { readonly package: string; readonly version: string };
  readonly grammars: readonly GrammarLockEntry[];
}

export interface GrammarLoaderOptions {
  /** Directory holding grammars.lock.json and the artifacts. Default: the vendored directory. */
  readonly dir?: string;
  readonly hasher?: Hasher;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
/** A bare file name: the lock must not be able to point the loader outside its directory. */
const isFileName = (v: unknown): v is string => isString(v) && !/[\\/]/.test(v) && v !== '.' && v !== '..';

const isHex64 = (v: unknown): boolean => typeof v === 'string' && HEX64.test(v);
const isSource = (v: unknown): boolean =>
  isRecord(v) && [v['package'], v['version'], v['tarball'], v['integrity']].every(isString);
const isArtifact = (v: unknown): boolean => isRecord(v) && isFileName(v['file']) && isHex64(v['sha256']) && isCount(v['bytes']);
const isLicense = (v: unknown): boolean => isRecord(v) && isString(v['spdx']) && isFileName(v['file']) && isHex64(v['sha256']);

function isEntry(v: unknown): v is GrammarLockEntry {
  return isRecord(v) && isString(v['language']) && isCount(v['abi']) && isSource(v['source']) && isArtifact(v['artifact']) && isLicense(v['license']);
}

/** Validates the lock's shape; it is data read from disk, so nothing about it is assumed. */
export function parseGrammarLock(json: unknown): Result<GrammarLock, DomainError> {
  const invalid = (why: string) => err(domainError('GRAMMAR_LOCK_INVALID', `${GRAMMAR_LOCK_FILE}: ${why}`));
  if (!isRecord(json) || json['format'] !== GRAMMAR_LOCK_FORMAT) return invalid(`format must be "${GRAMMAR_LOCK_FORMAT}"`);
  const runtime = json['runtime'];
  if (!isRecord(runtime) || !isString(runtime['package']) || !isString(runtime['version'])) return invalid('runtime is malformed');
  const grammars = json['grammars'];
  if (!Array.isArray(grammars) || grammars.length === 0) return invalid('grammars must be a non-empty array');
  const seen = new Set<string>();
  for (const g of grammars) {
    if (!isEntry(g)) return invalid('a grammar entry is malformed');
    if (seen.has(g.language)) return invalid(`language "${g.language}" is listed twice`);
    seen.add(g.language);
  }
  return { ok: true, value: json as unknown as GrammarLock };
}

let runtimeReady: Promise<void> | undefined;
/** Parser.init loads web-tree-sitter's own runtime .wasm; once per process is enough. */
function initRuntime(): Promise<void> {
  runtimeReady ??= Parser.init().catch((e: unknown) => {
    runtimeReady = undefined;
    throw e;
  });
  return runtimeReady;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class GrammarLoader {
  private readonly dir: string;
  private readonly hasher: Hasher;
  private lock: Promise<Result<GrammarLock, DomainError>> | undefined;
  private readonly languages = new Map<string, Promise<Result<Language, DomainError>>>();

  constructor(options: GrammarLoaderOptions = {}) {
    this.dir = options.dir ?? VENDORED_GRAMMARS_DIR;
    this.hasher = options.hasher ?? new NodeHasher();
  }

  /** The parsed lock, read once per loader. */
  readLock(): Promise<Result<GrammarLock, DomainError>> {
    this.lock ??= this.loadLock().then((r) => {
      if (!r.ok) this.lock = undefined;
      return r;
    });
    return this.lock;
  }

  /** The verified Language for `language`; the first call verifies, later calls return the cached result. */
  load(language: string): Promise<Result<Language, DomainError>> {
    let pending = this.languages.get(language);
    if (pending === undefined) {
      pending = this.verifyAndLoad(language).then((r) => {
        if (!r.ok) this.languages.delete(language);
        return r;
      });
      this.languages.set(language, pending);
    }
    return pending;
  }

  private async loadLock(): Promise<Result<GrammarLock, DomainError>> {
    let text: string;
    try {
      text = await readFile(path.join(this.dir, GRAMMAR_LOCK_FILE), 'utf8');
    } catch (e) {
      return err(domainError('GRAMMAR_LOCK_UNREADABLE', `${GRAMMAR_LOCK_FILE} cannot be read`, { code: (e as NodeJS.ErrnoException).code }));
    }
    try {
      return parseGrammarLock(JSON.parse(text) as unknown);
    } catch {
      return err(domainError('GRAMMAR_LOCK_INVALID', `${GRAMMAR_LOCK_FILE} is not valid JSON`));
    }
  }

  private async verifyAndLoad(language: string): Promise<Result<Language, DomainError>> {
    const lock = await this.readLock();
    if (!lock.ok) return lock;
    const entry = lock.value.grammars.find((g) => g.language === language);
    if (entry === undefined) return err(domainError('GRAMMAR_UNKNOWN_LANGUAGE', `no vendored grammar for "${language}"`, { language }));
    const { file, sha256, bytes: size } = entry.artifact;

    let bytes: Uint8Array;
    try {
      bytes = await readFile(path.join(this.dir, file));
    } catch (e) {
      return err(domainError('GRAMMAR_UNREADABLE', `${file} cannot be read`, { language, file, code: (e as NodeJS.ErrnoException).code }));
    }
    const actual = bytes.length === size ? this.hasher.sha256(bytes) : undefined;
    if (actual !== `sha256:${sha256}`) {
      return err(
        domainError('GRAMMAR_INTEGRITY_MISMATCH', `${file} does not match ${GRAMMAR_LOCK_FILE}`, {
          language,
          file,
          expected: { bytes: size, sha256 },
          actual: { bytes: bytes.length, sha256: actual?.slice('sha256:'.length) ?? null },
        }),
      );
    }

    let loaded: Language;
    try {
      await initRuntime();
      loaded = await Language.load(bytes);
    } catch (e) {
      return err(domainError('GRAMMAR_LOAD_FAILED', `${file} passed integrity checks but web-tree-sitter rejected it: ${message(e)}`, { language, file }));
    }
    if (loaded.abiVersion !== entry.abi) {
      return err(domainError('GRAMMAR_ABI_MISMATCH', `${file} has ABI ${loaded.abiVersion}, the lock records ${entry.abi}`, { language, file }));
    }
    return { ok: true, value: loaded };
  }
}

let processLoader: GrammarLoader | undefined;
/** The process-wide loader over the vendored grammars: each grammar is verified at most once per process. */
export function defaultGrammarLoader(): GrammarLoader {
  processLoader ??= new GrammarLoader();
  return processLoader;
}
