import { readFile } from 'node:fs/promises';

export const inject = ['agents', 'sessions', 'sessionQuery', 'workingDirectory', 'tools', 'connection', 'webServer'];

/** Stable entry; content-addressed implementation modules avoid stale ESM on reactivation. */
export async function apply(ctx, config = {}) {
  const manifest = JSON.parse(await readFile(new URL('./dist/runtime.json', import.meta.url), 'utf8'));
  if (!/^host-[a-f0-9]{16}\.js$/.test(manifest.host)) throw new Error('Invalid dsh-btw runtime manifest');
  const implementation = await import(new URL(`./dist/${manifest.host}`, import.meta.url).href);
  return implementation.apply(ctx, config);
}
