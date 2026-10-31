/**
 * ConfigSource over two files (SEC-005). The allow-lists live in the domain (parseWorkspaceSettings and
 * parseUserSettings); this adapter only locates, reads and JSON-parses:
 *   - workspace: <root>/cie.config.json, read through the FileSystem port, i.e. root-confined (WS-002);
 *   - user:      <userConfigDir>/config.json, which is outside every workspace.
 * A config file that exists but cannot be read or parsed is an error, never silently ignored: ignoring it
 * would quietly drop the user's exclusions.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalizePath,
  domainError,
  err,
  parseUserSettings,
  parseWorkspaceSettings,
  type ConfigSource,
  type DomainError,
  type FileSystem,
  type Result,
  type UserSettings,
  type WorkspaceSettings,
} from '@cie/core';

export const WORKSPACE_CONFIG_FILE = 'cie.config.json';
export const USER_CONFIG_FILE = 'config.json';

const decoder = new TextDecoder('utf-8', { fatal: true });

function parseJson(bytes: Uint8Array, source: string): Result<unknown, DomainError> {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(bytes)) as unknown };
  } catch {
    return err(domainError('CONFIG_INVALID_JSON', `${source} is not valid UTF-8 JSON`, { source }));
  }
}

export class FileConfigSource implements ConfigSource {
  constructor(
    private readonly fs: FileSystem,
    private readonly userConfigDir: string,
  ) {}

  async workspace(): Promise<Result<WorkspaceSettings, DomainError>> {
    const file = canonicalizePath(WORKSPACE_CONFIG_FILE);
    if (!file.ok) return file;
    const bytes = await this.fs.readFile(file.value, new AbortController().signal);
    if (!bytes.ok) {
      if (bytes.error.code === 'FS_NOT_FOUND') return parseWorkspaceSettings(undefined);
      return err(domainError('CONFIG_UNREADABLE', `${WORKSPACE_CONFIG_FILE} exists but cannot be read`, { cause: bytes.error.code }));
    }
    const json = parseJson(bytes.value, WORKSPACE_CONFIG_FILE);
    return json.ok ? parseWorkspaceSettings(json.value) : json;
  }

  async user(): Promise<Result<UserSettings, DomainError>> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path.join(this.userConfigDir, USER_CONFIG_FILE));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseUserSettings(undefined);
      return err(domainError('CONFIG_UNREADABLE', 'the user config file exists but cannot be read', { code: (e as NodeJS.ErrnoException).code }));
    }
    const json = parseJson(bytes, 'user config');
    return json.ok ? parseUserSettings(json.value) : json;
  }
}

/**
 * OS-conventional user config directory, overridable with CIE_CONFIG_DIR. It is never inside a workspace
 * unless the user deliberately points it there.
 */
export function defaultUserConfigDir(env: Readonly<Record<string, string | undefined>>, platform: string, home: string): string {
  if (env['CIE_CONFIG_DIR']) return path.resolve(env['CIE_CONFIG_DIR']);
  if (platform === 'win32') return path.join(env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'cie');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'cie');
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(home, '.config'), 'cie');
}
