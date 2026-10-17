import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const host = await build({
  entryPoints: ['src/index.js'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', target: 'node22', format: 'esm', packages: 'external',
  write: false, sourcemap: false, legalComments: 'eof', logLevel: 'info',
});
const hostCode = host.outputFiles[0].contents;
const hostName = `host-${createHash('sha256').update(hostCode).digest('hex').slice(0, 16)}.js`;
await writeFile(new URL(`../dist/${hostName}`, import.meta.url), hostCode);
await writeFile(new URL('../dist/runtime.json', import.meta.url), JSON.stringify({ host: hostName }) + '\n');
const client = await build({
  entryPoints: ['src/client/index.js'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', target: 'es2022', format: 'cjs', write: false,
  external: ['react', 'react/jsx-runtime'], sourcemap: false, legalComments: 'eof',
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-btw", factory(require) { const module = {exports:{}}; const exports = module.exports;' },
  footer: { js: 'return module.exports; } });' }, logLevel: 'info',
});
const clientCode = client.outputFiles[0].contents;
const clientName = `client-${createHash('sha256').update(clientCode).digest('hex').slice(0, 16)}.js`;
await writeFile(new URL(`../dist/${clientName}`, import.meta.url), clientCode);
const manifestUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
manifest.exports['./client'] = `./dist/${clientName}`;
manifest.files = ['index.js', `dist/${hostName}`, `dist/${clientName}`, 'dist/runtime.json', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'README.zh-CN.md', 'LICENSE'];
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
