/** Identifier of a user. */
export type UserId = string;

export enum Role {
  Admin = 'admin',
  Member = 'member',
}

/** A registered user. */
export interface User {
  id: UserId;
  name: string;
  role: Role;
  greet(other: User): string;
}

export class UserService {
  private readonly cache = new Map<UserId, User>();

  constructor(private readonly prefix: string) {}

  get count(): number {
    return this.cache.size;
  }

  find(id: UserId): User | undefined {
    return this.cache.get(id);
  }

  static create(): UserService {
    return new UserService('u');
  }
}

export function parseUser(input: string): User;
export function parseUser(input: Record<string, unknown>): User;
export function parseUser(input: unknown): User {
  return input as User;
}
