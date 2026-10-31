/**
 * Import edges (`imports`, `imports_symbol`) built from a FileExtraction by a resolver, with the SY-006
 * precision rules applied at construction (CODE_INTELLIGENCE_STRATEGY §1, §2.5; KNOWLEDGE_GRAPH_DESIGN §3):
 *  - `exact` requires the resolver's `imports` fidelity to be L3, `heuristic` requires at least L2;
 *    L0/L1 resolvers cannot resolve imports at all;
 *  - a non-literal specifier (`import(expr)`, `require(name)`, `importlib.import_module(x)`) can only target
 *    an `unresolved` placeholder: any concrete target would be a guess;
 *  - an unresolved edge carries no precision and has status `unknown`;
 *  - the edge cites the import it came from (file, range, content hash) as intrinsic evidence.
 * Requests that overstate precision are rejected rather than silently downgraded, so the producer bug
 * is visible.
 */
import type { CanonicalPath, ContentHash, DomainError, Hasher, NodeId, Result, SourceRange, SymbolId } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { atLeast, precisionAllowed, producerRef, type CapabilityProfile, type LanguageId, type Precision, type ProducerIdentity, type ProducerRef } from './capability.js';
import type { ExtractedImport, FileExtraction } from './file-extraction.js';

export type ImportEdgeType = 'imports' | 'imports_symbol';
/** `node` = Node.js built-in modules (`ext:node:fs`); `npm` and `pypi` = third-party packages. */
export type ExternalEcosystem = 'npm' | 'pypi' | 'node';

export type ImportTarget =
  | { readonly kind: 'module'; readonly language: LanguageId; readonly path: CanonicalPath }
  | { readonly kind: 'external'; readonly ecosystem: ExternalEcosystem; readonly name: string }
  | { readonly kind: 'symbol'; readonly id: SymbolId }
  | { readonly kind: 'unresolved' };

export type EdgeStatus = 'verified' | 'inferred' | 'unknown';

export interface ImportResolution {
  readonly type: ImportEdgeType;
  /** Position of the import in `FileExtraction.imports`. */
  readonly importIndex: number;
  /** For `imports_symbol`: the bound name, which must be one of the import's `names`. */
  readonly name: string | null;
  readonly target: ImportTarget;
  /** Requested precision; must be null for unresolved targets. */
  readonly precision: Precision | null;
}

export interface ImportResolver {
  readonly producer: ProducerIdentity;
  readonly profile: CapabilityProfile;
}

export interface StructuralEdge {
  readonly type: ImportEdgeType;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly toKind: ImportTarget['kind'];
  readonly status: EdgeStatus;
  readonly precision: Precision | null;
  readonly producer: ProducerRef;
  readonly evidence: { readonly kind: 'ast' | 'compiler' | 'heuristic'; readonly path: CanonicalPath; readonly range: SourceRange; readonly contentHash: ContentHash };
  readonly attrs: { readonly raw: string; readonly name: string | null; readonly isDynamic: boolean; readonly isTypeOnly: boolean };
}

export const moduleNodeId = (language: LanguageId, path: CanonicalPath): NodeId => `mod:${language}:${path}` as NodeId;

const EXTERNAL_NAME = /^[^\s\u0000-\u001f]+$/; // eslint-disable-line no-control-regex

export function externalNodeId(ecosystem: ExternalEcosystem, name: string): Result<NodeId, DomainError> {
  if (!EXTERNAL_NAME.test(name)) return err(domainError('EDGE_TARGET_INVALID', `external package name "${name}" is empty or contains whitespace`, { name }));
  return ok(`ext:${ecosystem}:${name}` as NodeId);
}

/**
 * `unres:<lang>:<path>#<siteHash>` (KNOWLEDGE_GRAPH_DESIGN §2). The site hash covers the import range, the raw
 * specifier, the edge type and the bound name, so each unresolved site gets its own placeholder.
 */
export function unresolvedNodeId(extraction: FileExtraction, imp: ExtractedImport, type: ImportEdgeType, name: string | null, hasher: Hasher): NodeId {
  const r = imp.range;
  const site = `${type}\n${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}\n${rawSpecifier(imp)}\n${name ?? ''}`;
  const siteHash = hasher.sha256Text(site).slice('sha256:'.length, 'sha256:'.length + 16);
  return `unres:${extraction.language}:${extraction.path}#${siteHash}` as NodeId;
}

const rawSpecifier = (imp: ExtractedImport): string => (imp.specifier.kind === 'literal' ? imp.specifier.value : imp.specifier.text);

const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> => err(domainError(code, message, details));

function checkSignature(res: ImportResolution, imp: ExtractedImport): Result<true, DomainError> {
  const { kind } = res.target;
  if (res.type === 'imports') {
    if (res.name !== null) return fail('EDGE_SIGNATURE_MISMATCH', 'an imports edge binds no name');
    if (kind === 'symbol') return fail('EDGE_SIGNATURE_MISMATCH', 'an imports edge targets a module, an external package or an unresolved site');
    return ok(true);
  }
  if (kind !== 'symbol' && kind !== 'unresolved') return fail('EDGE_SIGNATURE_MISMATCH', 'an imports_symbol edge targets a symbol or an unresolved site');
  if (res.name === null || !imp.names.includes(res.name)) {
    return fail('EDGE_EVIDENCE_MISSING', `import #${imp.index} does not bind "${res.name ?? ''}"`, { importIndex: imp.index, name: res.name });
  }
  return ok(true);
}

/** SY-006 for a concrete (non-placeholder) target. */
function checkPrecision(res: ImportResolution, imp: ExtractedImport, resolver: ImportResolver): Result<Precision, DomainError> {
  const fidelity = resolver.profile.fidelity.imports;
  if (imp.specifier.kind === 'expression') {
    return fail('SY_006_GUESSED_TARGET', `import #${imp.index} has a non-literal specifier (${imp.specifier.text}); only an unresolved target is allowed`, {
      importIndex: imp.index,
    });
  }
  if (res.precision === null) return fail('EDGE_PRECISION_REQUIRED', 'a resolved edge must state its precision');
  if (!precisionAllowed(res.precision, fidelity)) {
    return fail('SY_006_PRECISION_OVERSTATED', `${res.precision} precision needs ${res.precision === 'exact' ? 'L3' : 'L2+'} imports fidelity; the resolver declares ${fidelity}`, {
      requested: res.precision,
      fidelity,
      language: resolver.profile.language,
    });
  }
  return ok(res.precision);
}

function targetNodeId(extraction: FileExtraction, imp: ExtractedImport, res: ImportResolution, hasher: Hasher): Result<NodeId, DomainError> {
  const t = res.target;
  if (t.kind === 'module') return ok(moduleNodeId(t.language, t.path));
  if (t.kind === 'external') return externalNodeId(t.ecosystem, t.name);
  if (t.kind === 'symbol') return ok(t.id as string as NodeId);
  return ok(unresolvedNodeId(extraction, imp, res.type, res.name, hasher));
}

export function createImportEdge(extraction: FileExtraction, res: ImportResolution, resolver: ImportResolver, hasher: Hasher): Result<StructuralEdge, DomainError> {
  const imp = extraction.imports[res.importIndex];
  if (imp === undefined) return fail('EDGE_EVIDENCE_MISSING', `the extraction of ${extraction.path} has no import #${res.importIndex}`, { importIndex: res.importIndex });
  if (resolver.profile.language !== extraction.language) {
    return fail('CAPABILITY_LANGUAGE_MISMATCH', `resolver profile is for "${resolver.profile.language}", the file is "${extraction.language}"`);
  }
  if (!atLeast(resolver.profile.fidelity.imports, 'L1')) {
    return fail('SY_006_CAPABILITY_NOT_DECLARED', 'the resolver declares imports as L0 and cannot emit import edges', { language: extraction.language });
  }
  const signature = checkSignature(res, imp);
  if (!signature.ok) return signature;

  let precision: Precision | null = null;
  if (res.target.kind === 'unresolved') {
    if (res.precision !== null) return fail('SY_006_PRECISION_ON_UNRESOLVED', 'an edge to an unresolved site carries no precision');
  } else {
    const p = checkPrecision(res, imp, resolver);
    if (!p.ok) return p;
    precision = p.value;
  }
  const to = targetNodeId(extraction, imp, res, hasher);
  if (!to.ok) return to;

  const status: EdgeStatus = precision === 'exact' ? 'verified' : precision === 'heuristic' ? 'inferred' : 'unknown';
  return ok({
    type: res.type,
    from: moduleNodeId(extraction.language, extraction.path),
    to: to.value,
    toKind: res.target.kind,
    status,
    precision,
    producer: producerRef(resolver.producer, resolver.profile, 'imports'),
    evidence: { kind: precision === 'exact' ? 'compiler' : precision === 'heuristic' ? 'heuristic' : 'ast', path: extraction.path, range: imp.range, contentHash: extraction.contentHash },
    attrs: { raw: rawSpecifier(imp), name: res.name, isDynamic: imp.isDynamic, isTypeOnly: imp.isTypeOnly },
  });
}

/**
 * Validator form of SY-006 for edges read back from staging (they are plain data there): the stated
 * precision and status agree with the recorded producer fidelity, and placeholders carry no precision.
 */
export function importEdgeViolations(edge: StructuralEdge): readonly string[] {
  const out: string[] = [];
  const at = `${edge.type} ${edge.from} -> ${edge.to}`;
  if (edge.toKind === 'unresolved') {
    if (edge.precision !== null || edge.status !== 'unknown') out.push(`SY-006: ${at} targets an unresolved site but has precision ${edge.precision} / status ${edge.status}`);
  } else if (edge.precision === null || !precisionAllowed(edge.precision, edge.producer.fidelity)) {
    out.push(`SY-006: ${at} claims precision ${edge.precision} with producer fidelity ${edge.producer.fidelity}`);
  } else if ((edge.precision === 'exact') !== (edge.status === 'verified')) {
    out.push(`SY-006: ${at} has precision ${edge.precision} but status ${edge.status}`);
  }
  return out;
}
