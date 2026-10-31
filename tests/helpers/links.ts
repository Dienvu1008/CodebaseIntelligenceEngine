import { symlinkSync } from 'node:fs';

/** Directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
export function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** File symlink. Returns false if the OS refuses (Windows without symlink privilege), so the caller can skip and say why. */
export function tryLinkFile(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'file');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}
