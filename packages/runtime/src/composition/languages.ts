/**
 * Language adapters of the MVP (CODE_INTELLIGENCE_STRATEGY §3–§5): the tree-sitter extractor (L1 for ts, tsx,
 * js, py), the TypeScript import resolver (L3) and the Python import resolver (L2), registered in one
 * LanguageRegistry. The registry validates the set at startup, so a misconfiguration fails here.
 */
import { LangTsResolver, PythonImportResolver, TreeSitterExtractor } from '@cie/adapters';
import { LanguageRegistry, MVP_LANGUAGES, ok, type DomainError, type Hasher, type Result } from '@cie/core';

export async function createLanguageRegistry(hasher: Hasher): Promise<Result<LanguageRegistry, DomainError>> {
  const extractor = await TreeSitterExtractor.create({ hasher });
  if (!extractor.ok) return extractor;
  const ts = LangTsResolver.create({ hasher });
  if (!ts.ok) return ts;
  const py = PythonImportResolver.create({ hasher });
  if (!py.ok) return py;
  const registry = LanguageRegistry.create({ languages: MVP_LANGUAGES, extractors: [extractor.value], resolvers: [ts.value, py.value] });
  return registry.ok ? ok(registry.value) : registry;
}
