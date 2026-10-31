import type { User } from './models/user';
import { capitalize } from './util/strings';

export function UserCard({ user }: { user: User }) {
  return <div className="card">{capitalize(user.name)}</div>;
}
