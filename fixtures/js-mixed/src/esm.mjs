import { readFile } from 'node:fs/promises';

export const VERSION = '1.0.0';

export async function loadLocale(lang) {
  const messages = await import(`./locales/${lang}.mjs`);
  const fallback = await import('./locales/en.mjs');
  return messages.default ?? fallback.default ?? readFile;
}
