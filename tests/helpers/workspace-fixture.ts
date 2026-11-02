// In-memory workspaces for resolver tests: files → manifest, a FileSystem port, L1 extractions, resolution.
import { NodeHasher, TreeSitterExtractor } from '@cie/adapters';
import {
  canonicalizePath,
  domainError,
  err,
  languageForPath,
  ok,
  type CanonicalPath,
  type FileExtraction,
  type FileSystem,
  type LanguageId,
  type ManifestEntry,
  type ProjectResolution,
  type ProjectResolver,
  type ResolvedEdge,
} from '@cie/core';

const hasher = new NodeHasher();
const encoder = new TextEncoder();
let extractor: TreeSitterExtractor | undefined;

async function treesitter(): Promise<TreeSitterExtractor> {
  if (extractor === undefined) {
    const x = await TreeSitterExtractor.create();
    if (!x.ok) throw new Error(x.error.message);
    extractor = x.value;
  }
  return extractor;
}

export function memoryFs(files: Readonly<Record<string, string>>): FileSystem {
  return {
    readFile: (path) =>
      Promise.resolve(path in files ? ok(encoder.encode(files[path] as string)) : err(domainError('FS_NOT_FOUND', `${path} not found`))),
    stat: () => Promise.resolve(null),
    realpath: (path) => Promise.resolve({ kind: 'inside', path }),
    list: () => Promise.resolve(ok([])),
  };
}

export interface FixtureRun {
  readonly manifest: readonly ManifestEntry[];
  readonly extractions: readonly FileExtraction[];
  readonly resolution: ProjectResolution;
}

/** Enumerates, extracts every MVP-language file with the tree-sitter extractor, then resolves. */
export async function resolveFixture(files: Readonly<Record<string, string>>, resolver: ProjectResolver): Promise<FixtureRun> {
  const x = await treesitter();
  const paths = Object.keys(files).sort();
  const manifest: ManifestEntry[] = [];
  const extractions: FileExtraction[] = [];
  for (const raw of paths) {
    const path = canonicalizePath(raw);
    if (!path.ok) throw new Error(`bad fixture path ${raw}`);
    const bytes = encoder.encode(files[raw] as string);
    const language = languageForPath(path.value);
    manifest.push({ path: path.value, status: 'indexed', hash: hasher.sha256(bytes), size: bytes.length, language });
    if (language === null) continue;
    const e = await x.extractFile({ path: path.value, language: language as LanguageId, content: bytes, contentHash: hasher.sha256(bytes) }, new AbortController().signal);
    if (!e.ok) throw new Error(`${raw}: ${e.error.message}`);
    extractions.push(e.value);
  }
  const r = await resolver.resolve({ manifest, extractions, fs: memoryFs(files) }, new AbortController().signal);
  if (!r.ok) throw new Error(r.error.message);
  return { manifest, extractions, resolution: r.value };
}

/** Compact, sorted view of edges for assertions: `from -> to [type status precision] name?`. */
export function edgeSummary(edges: readonly ResolvedEdge[]): string[] {
  return edges.map((e) => {
    const name = 'name' in e.attrs ? e.attrs.name : null;
    return `${e.from} -> ${e.to} [${e.type} ${e.status}${e.precision === null ? '' : ` ${e.precision}`}]${name === null ? '' : ` ${name}`}`;
  });
}

export const cp = (p: string): CanonicalPath => p as CanonicalPath;
