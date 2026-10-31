export const slugify = (s: string): string => s.toLowerCase().replace(/\s+/g, '-');

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const internal = 42;

export default function shout(s: string): string {
  return `${s}!`.repeat(internal > 0 ? 1 : 0);
}
