/**
 * Capability profiles, fidelity and precision (CODE_INTELLIGENCE_STRATEGY §1 and §5; SY-005, SY-006).
 *
 * A producer declares, per language, how faithfully it covers each capability:
 *   L0 not supported · L1 syntactic · L2 deterministic heuristic · L3 semantically exact.
 * Precision is derived from that declaration and can never exceed it: only an L3 capability may emit an
 * `exact` edge, an L2 capability at most a `heuristic` one, and L0/L1 capabilities emit no resolved edges.
 */
import type { Brand, DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';

/** Adapter language id. The MVP ids are listed; a new adapter adds its own through `languageId`. */
export type LanguageId = 'ts' | 'tsx' | 'js' | 'py' | Brand<string, 'LanguageId'>;

const LANGUAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Validates a language id: lowercase ASCII, starts with a letter, at most 32 characters. */
export function languageId(raw: string): Result<LanguageId, DomainError> {
  if (!LANGUAGE_ID.test(raw)) return err(domainError('INVALID_LANGUAGE_ID', `"${raw}" is not a valid language id`, { value: raw }));
  return ok(raw as LanguageId);
}

export type Fidelity = 'L0' | 'L1' | 'L2' | 'L3';
export const FIDELITIES: readonly Fidelity[] = ['L0', 'L1', 'L2', 'L3'];

export type Capability = 'symbols' | 'imports' | 'references' | 'calls' | 'typeRelations' | 'di' | 'docstrings';
export const CAPABILITIES: readonly Capability[] = ['symbols', 'imports', 'references', 'calls', 'typeRelations', 'di', 'docstrings'];

export type Precision = 'exact' | 'heuristic';

export interface CapabilityProfile {
  readonly language: LanguageId;
  readonly fidelity: Readonly<Record<Capability, Fidelity>>;
}

/** Which adapter, at which version, over which tool version produced a fact. */
export interface ProducerIdentity {
  /** 'treesitter' | 'lang-ts' | 'lang-python' | 'scip' | … */
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** e.g. 'web-tree-sitter@0.27.1+tree-sitter-python@0.25.0' */
  readonly toolVersion: string;
}

/** Attribution recorded on every symbol and edge (SY-005): the producer plus the fidelity it claimed. */
export interface ProducerRef extends ProducerIdentity {
  readonly fidelity: Fidelity;
}

const rank = (f: Fidelity): number => FIDELITIES.indexOf(f);
export const atLeast = (actual: Fidelity, required: Fidelity): boolean => rank(actual) >= rank(required);

/** Builds a profile; every capability must be declared explicitly, so a gap is always an explicit L0. */
export function capabilityProfile(language: LanguageId, fidelity: Readonly<Record<string, string>>): Result<CapabilityProfile, DomainError> {
  const declared = Object.keys(fidelity);
  const unknown = declared.filter((k) => !(CAPABILITIES as readonly string[]).includes(k));
  if (unknown.length > 0) return err(domainError('CAPABILITY_UNKNOWN', `unknown capabilities: ${unknown.sort().join(', ')}`, { language, unknown }));
  const out = {} as Record<Capability, Fidelity>;
  for (const c of CAPABILITIES) {
    const f = fidelity[c];
    if (f === undefined || !(FIDELITIES as readonly string[]).includes(f)) {
      return err(domainError('CAPABILITY_FIDELITY_INVALID', `capability "${c}" needs a fidelity of L0..L3`, { language, capability: c, value: f ?? null }));
    }
    out[c] = f as Fidelity;
  }
  return ok({ language, fidelity: out });
}

const PRODUCER_PART = /^[A-Za-z0-9][A-Za-z0-9._@+/-]*$/;

/** Validates a producer identity. The parts are stored and compared verbatim, so they must be printable tokens. */
export function producerIdentity(adapterId: string, adapterVersion: string, toolVersion: string): Result<ProducerIdentity, DomainError> {
  for (const [field, value] of [['adapterId', adapterId], ['adapterVersion', adapterVersion], ['toolVersion', toolVersion]] as const) {
    if (!PRODUCER_PART.test(value)) return err(domainError('PRODUCER_INVALID', `producer ${field} "${value}" is not a printable token`, { field, value }));
  }
  return ok({ adapterId, adapterVersion, toolVersion });
}

/** The ProducerRef for facts of `capability`, carrying the fidelity the profile declares for it. */
export function producerRef(producer: ProducerIdentity, profile: CapabilityProfile, capability: Capability): ProducerRef {
  return { adapterId: producer.adapterId, adapterVersion: producer.adapterVersion, toolVersion: producer.toolVersion, fidelity: profile.fidelity[capability] };
}

/** Canonical one-line form, e.g. `lang-ts@0.1.0+typescript@6.0.3`, as stored in the index (`node.producer`). */
export function formatProducer(p: ProducerIdentity): string {
  return `${p.adapterId}@${p.adapterVersion}+${p.toolVersion}`;
}

/** The highest precision an edge backed by a capability of this fidelity may claim; null means no resolved edges. */
export function maxPrecision(f: Fidelity): Precision | null {
  if (f === 'L3') return 'exact';
  if (f === 'L2') return 'heuristic';
  return null;
}

/** True when `requested` does not overstate what `fidelity` allows (SY-006). */
export function precisionAllowed(requested: Precision, fidelity: Fidelity): boolean {
  const max = maxPrecision(fidelity);
  return max === 'exact' || (max === 'heuristic' && requested === 'heuristic');
}
