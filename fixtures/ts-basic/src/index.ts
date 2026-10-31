import { z } from 'zod';
import shout, { slugify } from './util/strings';
import { UserService, type User } from './models/user';
import { readFile } from 'node:fs/promises';

export { UserCard } from './view';
export * from './models/user';

export const schema = z.object({ name: z.string() });

export async function main(path: string): Promise<User | undefined> {
  const text = await readFile(path, 'utf8');
  return UserService.create().find(slugify(shout(text)));
}
