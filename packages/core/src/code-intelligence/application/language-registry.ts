/**
 * LanguageRegistry (CODE_INTELLIGENCE_STRATEGY §4): extension → language → (extractor, resolvers[]).
 *
 * The composition root registers adapters; the registry validates the whole set once, so misconfiguration
 * fails at startup instead of mid-index:
 *  - every extension belongs to exactly one language, and every adapter profile names a known language;
 *  - a language has at most one FileExtractor; resolvers are ordered by `imports` fidelity (highest first,
 *    then adapterId), the order in which their edges supersede each other for the same site;
 *  - an adapter declares each language once.
 * `capabilities(lang)` is the effective profile (the best fidelity any registered adapter declares per
 * capability). It is what `cie dev status` reports as the capability matrix.
 */
import type { CanonicalPath, DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { atLeast, CAPABILITIES, type Capability, type CapabilityProfile, type Fidelity, type LanguageId } from '../domain/capability.js';
import { extensionOf, type LanguageDefinition } from '../domain/languages.js';
import type { FileExtractor, LanguageAdapter, ProjectResolver } from './ports.js';

export interface LanguageRegistryInput {
  readonly languages: readonly LanguageDefinition[];
  readonly extractors: readonly FileExtractor[];
  readonly resolvers: readonly ProjectResolver[];
}

const EXTENSION = /^[A-Za-z0-9_+-]+$/;
const byString = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

function profileOf(adapter: LanguageAdapter, language: LanguageId): CapabilityProfile | null {
  return adapter.profiles.find((p) => p.language === language) ?? null;
}

function checkLanguages(languages: readonly LanguageDefinition[]): Result<Map<string, LanguageId>, DomainError> {
  const ids = new Set<string>();
  const byExtension = new Map<string, LanguageId>();
  for (const def of languages) {
    if (ids.has(def.id)) return err(domainError('REGISTRY_LANGUAGE_DUPLICATE', `language "${def.id}" is defined twice`, { language: def.id }));
    ids.add(def.id);
    if (def.extensions.length === 0) return err(domainError('REGISTRY_EXTENSION_INVALID', `language "${def.id}" has no extensions`, { language: def.id }));
    for (const ext of def.extensions) {
      if (!EXTENSION.test(ext)) return err(domainError('REGISTRY_EXTENSION_INVALID', `extension "${ext}" of "${def.id}" must be a bare suffix without a dot`, { language: def.id, extension: ext }));
      const owner = byExtension.get(ext);
      if (owner !== undefined) {
        return err(domainError('REGISTRY_EXTENSION_CONFLICT', `extension "${ext}" is claimed by both "${owner}" and "${def.id}"`, { extension: ext, languages: [owner, def.id] }));
      }
      byExtension.set(ext, def.id);
    }
  }
  return ok(byExtension);
}

function checkAdapter(adapter: LanguageAdapter, known: ReadonlySet<string>): Result<true, DomainError> {
  const seen = new Set<string>();
  const name = adapter.producer.adapterId;
  for (const p of adapter.profiles) {
    if (!known.has(p.language)) return err(domainError('REGISTRY_UNKNOWN_LANGUAGE', `adapter "${name}" declares unknown language "${p.language}"`, { adapter: name, language: p.language }));
    if (seen.has(p.language)) return err(domainError('REGISTRY_PROFILE_DUPLICATE', `adapter "${name}" declares "${p.language}" twice`, { adapter: name, language: p.language }));
    seen.add(p.language);
  }
  if (adapter.profiles.length === 0) return err(domainError('REGISTRY_PROFILE_MISSING', `adapter "${name}" declares no language`, { adapter: name }));
  return ok(true);
}

function buildExtractors(extractors: readonly FileExtractor[]): Result<Map<string, FileExtractor>, DomainError> {
  const out = new Map<string, FileExtractor>();
  for (const x of extractors) {
    for (const p of x.profiles) {
      const other = out.get(p.language);
      if (other !== undefined) {
        return err(domainError('REGISTRY_EXTRACTOR_CONFLICT', `"${p.language}" has two extractors: ${other.producer.adapterId} and ${x.producer.adapterId}`, { language: p.language }));
      }
      out.set(p.language, x);
    }
  }
  return ok(out);
}

function buildResolvers(resolvers: readonly ProjectResolver[]): Result<Map<string, ProjectResolver[]>, DomainError> {
  const out = new Map<string, ProjectResolver[]>();
  for (const r of resolvers) {
    for (const p of r.profiles) {
      const list = out.get(p.language) ?? [];
      if (list.some((o) => o.producer.adapterId === r.producer.adapterId)) {
        return err(domainError('REGISTRY_RESOLVER_CONFLICT', `"${p.language}" has resolver "${r.producer.adapterId}" twice`, { language: p.language }));
      }
      list.push(r);
      out.set(p.language, list);
    }
  }
  for (const [language, list] of out) {
    const fidelity = (r: ProjectResolver): Fidelity => profileOf(r, language as LanguageId)?.fidelity.imports ?? 'L0';
    list.sort((a, b) => {
      const fa = fidelity(a);
      const fb = fidelity(b);
      if (fa !== fb) return atLeast(fa, fb) ? -1 : 1;
      return byString(a.producer.adapterId, b.producer.adapterId);
    });
  }
  return ok(out);
}

export class LanguageRegistry {
  private constructor(
    private readonly definitions: readonly LanguageDefinition[],
    private readonly byExtension: ReadonlyMap<string, LanguageId>,
    private readonly extractors: ReadonlyMap<string, FileExtractor>,
    private readonly resolvers: ReadonlyMap<string, readonly ProjectResolver[]>,
  ) {}

  static create(input: LanguageRegistryInput): Result<LanguageRegistry, DomainError> {
    const byExtension = checkLanguages(input.languages);
    if (!byExtension.ok) return byExtension;
    const known = new Set(input.languages.map((d) => d.id as string));
    for (const a of [...input.extractors, ...input.resolvers]) {
      const c = checkAdapter(a, known);
      if (!c.ok) return c;
    }

    const extractors = buildExtractors(input.extractors);
    if (!extractors.ok) return extractors;
    const resolvers = buildResolvers(input.resolvers);
    if (!resolvers.ok) return resolvers;
    const definitions = [...input.languages].sort((a, b) => byString(a.id, b.id));
    return ok(new LanguageRegistry(definitions, byExtension.value, extractors.value, resolvers.value));
  }

  /** Registered languages, sorted by id. */
  languages(): readonly LanguageDefinition[] {
    return this.definitions;
  }

  /** The language of a file, by its extension (case-sensitive), or null when no language claims it. */
  languageForPath(path: CanonicalPath): LanguageId | null {
    const ext = extensionOf(path);
    return ext === null ? null : (this.byExtension.get(ext) ?? null);
  }

  extractorFor(language: LanguageId): FileExtractor | null {
    return this.extractors.get(language) ?? null;
  }

  /** Resolvers for a language, highest `imports` fidelity first; earlier resolvers' edges win for the same site. */
  resolversFor(language: LanguageId): readonly ProjectResolver[] {
    return this.resolvers.get(language) ?? [];
  }

  /** Effective profile: per capability, the best fidelity declared by the extractor or any resolver (L0 if none). */
  capabilities(language: LanguageId): CapabilityProfile {
    const adapters: LanguageAdapter[] = [...(this.extractors.has(language) ? [this.extractors.get(language) as FileExtractor] : []), ...this.resolversFor(language)];
    const fidelity = {} as Record<Capability, Fidelity>;
    for (const c of CAPABILITIES) {
      fidelity[c] = adapters.reduce<Fidelity>((best, a) => {
        const f = profileOf(a, language)?.fidelity[c] ?? 'L0';
        return atLeast(f, best) ? f : best;
      }, 'L0');
    }
    return { language, fidelity };
  }

  /** The capability matrix: one effective profile per registered language, sorted by language id. */
  capabilityMatrix(): readonly CapabilityProfile[] {
    return this.definitions.map((d) => this.capabilities(d.id));
  }
}
