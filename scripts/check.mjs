import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(path);
  }
  return files;
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.name !== 'dsh-btw') throw new Error('Wrong package identity');
for (const file of [...await sourceFiles('src'), ...await sourceFiles('scripts')]) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const locale of ['en', 'zh']) {
  const data = JSON.parse(await readFile(`locale/${locale}.json`, 'utf8'));
  if (!data.meta?.title || !data.meta?.description) throw new Error(`Missing ${locale} display metadata`);
}
for (const file of await sourceFiles('src/client')) {
  const code = await readFile(file, 'utf8');
  if (/(?:from\s*|import\s*\(|require\s*\()\s*['"]@deepseek-ai\//.test(code)) {
    throw new Error(`Forbidden Harness Client runtime import: ${file}`);
  }
}
await import('./test.mjs');
if (process.exitCode) process.exit(process.exitCode);
await import('./build.mjs');
