import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, 'apps/desktop/dist');
await build({
  entryPoints: [resolve(root, 'apps/desktop/src/main.ts')],
  outfile: resolve(output, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
});
await build({
  entryPoints: [resolve(root, 'apps/desktop/src/preload.ts')],
  outfile: resolve(output, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
});
