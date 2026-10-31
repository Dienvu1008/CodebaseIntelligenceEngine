// SEC-005: sensitive settings never come from the workspace. cie.config.json is untrusted repository content:
// only non-sensitive keys are accepted, sensitive keys are rejected explicitly, unknown keys are rejected, and
// the file is read through the root-confined FileSystem (a symlink pointing outside cannot smuggle settings in).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileConfigSource, GuardedFileSystem } from '@cie/adapters';
import { DEFAULT_USER_SETTINGS, parseUserSettings, parseWorkspaceSettings } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tryLinkFile } from '../../helpers/links.js';

const code = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe('SEC-005: workspace allow-list (domain)', () => {
  it.each(['llm', 'provider', 'endpoint', 'apiKey', 'consent', 'wiki', 'publishGenerated', 'enrichers', 'telemetry'])(
    'rejects the sensitive key "%s" in cie.config.json',
    (key) => {
      expect(code(parseWorkspaceSettings({ [key]: 'anything' }))).toBe('CONFIG_SENSITIVE_KEY_IN_WORKSPACE');
    },
  );

  it('rejects unknown keys (so a typo cannot silently disable a setting)', () => {
    expect(code(parseWorkspaceSettings({ ignroe: ['x'] }))).toBe('CONFIG_UNKNOWN_KEY');
  });

  it('accepts the non-sensitive keys and applies defaults', () => {
    expect(parseWorkspaceSettings({ version: 1, ignore: ['gen/'], maxFileBytes: 2048, wikiDir: 'docs\\wiki' })).toEqual({
      ok: true,
      value: { ignore: ['gen/'], maxFileBytes: 2048, wikiDir: 'docs/wiki' },
    });
    expect(parseWorkspaceSettings(undefined)).toMatchObject({ ok: true, value: { ignore: [], wikiDir: undefined } });
  });

  it.each([
    [{ wikiDir: '../outside' }],
    [{ wikiDir: '/abs' }],
    [{ maxFileBytes: 0 }],
    [{ maxFileBytes: 1e12 }],
    [{ ignore: ['a\nb'] }],
    [{ version: 2 }],
    [['not', 'an', 'object']],
  ])('rejects invalid values %j', (raw) => {
    expect(parseWorkspaceSettings(raw).ok).toBe(false);
  });

  it('parses user settings strictly, defaulting to no LLM', () => {
    expect(parseUserSettings(undefined)).toEqual({ ok: true, value: DEFAULT_USER_SETTINGS });
    expect(parseUserSettings({ llm: { provider: 'ollama' }, wiki: { publishGenerated: true } })).toEqual({
      ok: true,
      value: { llmProvider: 'ollama', publishGenerated: true },
    });
    expect(code(parseUserSettings({ llm: { provider: 'evil-cloud' } }))).toBe('CONFIG_INVALID_VALUE');
    expect(code(parseUserSettings({ llm: { endpoint: 'http://x' } }))).toBe('CONFIG_UNKNOWN_KEY');
  });
});

describe('SEC-005: FileConfigSource (adapter)', () => {
  let dir: string;
  let ws: string;
  let userDir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cie-sec005-'));
    ws = path.join(dir, 'ws');
    userDir = path.join(dir, 'user');
    mkdirSync(ws, { recursive: true });
    mkdirSync(userDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const source = async () => new FileConfigSource(await GuardedFileSystem.open(ws), userDir);

  it('refuses a repository that tries to choose the LLM provider', async () => {
    writeFileSync(path.join(ws, 'cie.config.json'), JSON.stringify({ llm: { provider: 'openai-compatible' } }));
    expect(code(await (await source()).workspace())).toBe('CONFIG_SENSITIVE_KEY_IN_WORKSPACE');
  });

  it('takes sensitive settings from the user directory only', async () => {
    writeFileSync(path.join(userDir, 'config.json'), JSON.stringify({ llm: { provider: 'ollama' } }));
    writeFileSync(path.join(ws, 'cie.config.json'), JSON.stringify({ ignore: ['tmp/'] }));
    const s = await source();
    expect(await s.user()).toEqual({ ok: true, value: { llmProvider: 'ollama', publishGenerated: false } });
    expect(await s.workspace()).toMatchObject({ ok: true, value: { ignore: ['tmp/'] } });
  });

  it('treats malformed JSON as an error rather than as "no config"', async () => {
    writeFileSync(path.join(ws, 'cie.config.json'), '{ not json');
    expect(code(await (await source()).workspace())).toBe('CONFIG_INVALID_JSON');
  });

  it('refuses a cie.config.json symlink that points outside the workspace', async (ctx) => {
    writeFileSync(path.join(dir, 'outside.json'), JSON.stringify({ ignore: [] }));
    if (!tryLinkFile(path.join(dir, 'outside.json'), path.join(ws, 'cie.config.json'))) {
      console.warn('[SEC-005] file symlink not created (EPERM); case skipped on this machine');
      ctx.skip();
    }
    expect(code(await (await source()).workspace())).toBe('CONFIG_UNREADABLE');
  });
});
