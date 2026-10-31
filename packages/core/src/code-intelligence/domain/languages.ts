/**
 * Language definitions: which file extensions belong to which adapter language (CODE_INTELLIGENCE_STRATEGY §3).
 * The LanguageRegistry is built from these, and it is the authority on file languages. The Phase 01
 * extension map in the workspace context (`languageForPath`) must agree with MVP_LANGUAGES; a golden test
 * enforces that, because the workspace context cannot depend on code-intelligence (DEPENDENCY_RULES C5).
 */
import type { CanonicalPath } from '../../shared-kernel/index.js';
import type { LanguageId } from './capability.js';

export interface LanguageDefinition {
  readonly id: LanguageId;
  /** Extensions without the dot, matched case-sensitively against the last `.`-suffix of the file name. */
  readonly extensions: readonly string[];
}

export const MVP_LANGUAGES: readonly LanguageDefinition[] = [
  { id: 'ts', extensions: ['ts', 'mts', 'cts'] },
  { id: 'tsx', extensions: ['tsx'] },
  { id: 'js', extensions: ['js', 'mjs', 'cjs', 'jsx'] },
  { id: 'py', extensions: ['py', 'pyi'] },
];

/**
 * The extension of a path's last segment, or null when it has none. A leading dot does not start an
 * extension (`.eslintrc` has none), and only the last suffix counts (`a.d.ts` → `ts`).
 */
export function extensionOf(path: CanonicalPath): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? null : name.slice(dot + 1);
}
