import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Join a '/'-separated repo-relative path onto the repository root. */
export const repoPath = (rel: string): string => path.join(REPO_ROOT, ...rel.split('/'));
