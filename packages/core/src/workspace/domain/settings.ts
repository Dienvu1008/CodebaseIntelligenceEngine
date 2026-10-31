/**
 * Settings parsing with per-source allow-lists (SEC-005, NFR-032, FR-003, FR-007).
 *
 * Workspace settings come from `cie.config.json`, which is UNTRUSTED repository content. It may contain only
 * non-sensitive keys. Anything security-relevant (LLM provider, endpoints, consent, publishing, enrichers,
 * telemetry) is rejected outright, so a cloned repository can never redirect CIE. Those settings exist only
 * in user-level configuration. Unknown keys are rejected in both sources, so a typo cannot silently disable
 * a setting.
 */
import type { CanonicalPath, DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { canonicalizePath } from './path-canonicalizer.js';

/** Default per-file size limit (FR-007). [Proposal] 1 MiB; revisited with the Phase 05 baselines. */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;
/** Upper bound for maxFileBytes, as a guard against resource exhaustion (SECURITY T9). */
export const MAX_MAX_FILE_BYTES = 64 * 1_048_576;

export interface WorkspaceSettings {
  /** Extra ignore patterns (gitignore syntax), applied in the highest-precedence layer. */
  readonly ignore: readonly string[];
  readonly maxFileBytes: number;
  readonly wikiDir: CanonicalPath | undefined;
}

export type LlmProviderSetting = 'none' | 'ollama' | 'openai-compatible';

export interface UserSettings {
  readonly llmProvider: LlmProviderSetting;
  readonly publishGenerated: boolean;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { ignore: [], maxFileBytes: DEFAULT_MAX_FILE_BYTES, wikiDir: undefined };
export const DEFAULT_USER_SETTINGS: UserSettings = { llmProvider: 'none', publishGenerated: false };

const WORKSPACE_KEYS = new Set(['$schema', 'version', 'ignore', 'maxFileBytes', 'wikiDir']);
/** Keys that are sensitive anywhere. They get a specific error, so the user learns where they belong. */
const SENSITIVE_KEYS = new Set([
  'llm',
  'provider',
  'endpoint',
  'endpoints',
  'apiKey',
  'consent',
  'wiki',
  'publishGenerated',
  'enrichers',
  'telemetry',
]);
const USER_KEYS = new Set(['$schema', 'version', 'llm', 'wiki']);
const LLM_PROVIDERS: readonly LlmProviderSetting[] = ['none', 'ollama', 'openai-compatible'];

const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> =>
  err(domainError(code, message, details));

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkVersion(obj: Record<string, unknown>, source: string): Result<void, DomainError> {
  if (obj['version'] !== undefined && obj['version'] !== 1) return fail('CONFIG_UNSUPPORTED_VERSION', `${source}: version must be 1`);
  return ok(undefined);
}

function parseIgnore(v: unknown): Result<readonly string[], DomainError> {
  if (v === undefined) return ok([]);
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && !/[\r\n]/.test(p))) {
    return fail('CONFIG_INVALID_VALUE', 'cie.config.json: ignore must be an array of single-line strings');
  }
  return ok(v as string[]);
}

function parseMaxFileBytes(v: unknown): Result<number, DomainError> {
  if (v === undefined) return ok(DEFAULT_MAX_FILE_BYTES);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_MAX_FILE_BYTES) {
    return fail('CONFIG_INVALID_VALUE', `cie.config.json: maxFileBytes must be an integer in 1..${MAX_MAX_FILE_BYTES}`);
  }
  return ok(v);
}

function parseWikiDir(v: unknown): Result<CanonicalPath | undefined, DomainError> {
  if (v === undefined) return ok(undefined);
  const c = typeof v === 'string' ? canonicalizePath(v) : null;
  if (c === null || !c.ok) return fail('CONFIG_INVALID_VALUE', 'cie.config.json: wikiDir must be a workspace-relative path inside the workspace');
  return ok(c.value);
}

/** `raw` is the parsed JSON of cie.config.json, or undefined when the file does not exist. */
export function parseWorkspaceSettings(raw: unknown): Result<WorkspaceSettings, DomainError> {
  if (raw === undefined) return ok(DEFAULT_WORKSPACE_SETTINGS);
  if (!isPlainObject(raw)) return fail('CONFIG_INVALID_VALUE', 'cie.config.json must contain a JSON object');
  for (const key of Object.keys(raw)) {
    if (SENSITIVE_KEYS.has(key)) {
      return fail('CONFIG_SENSITIVE_KEY_IN_WORKSPACE', `cie.config.json must not contain "${key}": security-sensitive settings are read only from user configuration (SEC-005)`, { key });
    }
    if (!WORKSPACE_KEYS.has(key)) return fail('CONFIG_UNKNOWN_KEY', `cie.config.json: unknown key "${key}"`, { key });
  }
  const version = checkVersion(raw, 'cie.config.json');
  if (!version.ok) return version;
  const ignore = parseIgnore(raw['ignore']);
  if (!ignore.ok) return ignore;
  const maxFileBytes = parseMaxFileBytes(raw['maxFileBytes']);
  if (!maxFileBytes.ok) return maxFileBytes;
  const wikiDir = parseWikiDir(raw['wikiDir']);
  if (!wikiDir.ok) return wikiDir;
  return ok({ ignore: ignore.value, maxFileBytes: maxFileBytes.value, wikiDir: wikiDir.value });
}

function parseSection(raw: Record<string, unknown>, key: string, allowed: readonly string[]): Result<Record<string, unknown>, DomainError> {
  const v = raw[key];
  if (v === undefined) return ok({});
  if (!isPlainObject(v)) return fail('CONFIG_INVALID_VALUE', `user config: ${key} must be an object`);
  const unknown = Object.keys(v).find((k) => !allowed.includes(k));
  return unknown === undefined ? ok(v) : fail('CONFIG_UNKNOWN_KEY', `user config: unknown key "${key}.${unknown}"`, { key: `${key}.${unknown}` });
}

/** `raw` is the parsed JSON of the user config file, or undefined when it does not exist. */
export function parseUserSettings(raw: unknown): Result<UserSettings, DomainError> {
  if (raw === undefined) return ok(DEFAULT_USER_SETTINGS);
  if (!isPlainObject(raw)) return fail('CONFIG_INVALID_VALUE', 'user config must contain a JSON object');
  const unknown = Object.keys(raw).find((k) => !USER_KEYS.has(k));
  if (unknown !== undefined) return fail('CONFIG_UNKNOWN_KEY', `user config: unknown key "${unknown}"`, { key: unknown });
  const version = checkVersion(raw, 'user config');
  if (!version.ok) return version;
  const llm = parseSection(raw, 'llm', ['provider']);
  if (!llm.ok) return llm;
  const wiki = parseSection(raw, 'wiki', ['publishGenerated']);
  if (!wiki.ok) return wiki;
  const provider = llm.value['provider'] ?? 'none';
  if (!LLM_PROVIDERS.includes(provider as LlmProviderSetting)) {
    return fail('CONFIG_INVALID_VALUE', `user config: llm.provider must be one of ${LLM_PROVIDERS.join(', ')}`);
  }
  const publish = wiki.value['publishGenerated'] ?? false;
  if (typeof publish !== 'boolean') return fail('CONFIG_INVALID_VALUE', 'user config: wiki.publishGenerated must be a boolean');
  return ok({ llmProvider: provider as LlmProviderSetting, publishGenerated: publish });
}
