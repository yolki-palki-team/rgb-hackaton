import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packager } from '@electron/packager';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, '.dist/desktop');
const stage = resolve(root, '.dist/desktop-stage');

function run(script: string): void {
  const result = spawnSync('npm', ['run', script], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${resolve(root, 'node_modules/node/bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  if (result.status !== 0) throw new Error(`${script} failed`);
}

if (process.platform !== 'darwin')
  throw new Error('The desktop package script currently builds for macOS on a macOS host');
run('build:local');
run('build:desktop');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true, mode: 0o700 });
writeFileSync(
  resolve(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'palka-desktop',
      version: '0.1.0',
      private: true,
      type: 'module',
      main: 'apps/desktop/dist/main.cjs',
    },
    null,
    2,
  ),
);
for (const path of [
  'apps/desktop/dist',
  'apps/local-client/src',
  'apps/local-client/ui/dist',
  'packages/contracts',
]) {
  if (!existsSync(resolve(root, path))) throw new Error(`Missing desktop runtime input: ${path}`);
  cpSync(resolve(root, path), resolve(stage, path), { recursive: true });
}
const modules = resolve(root, 'node_modules');
cpSync(modules, resolve(stage, 'node_modules'), {
  recursive: true,
  filter: (source) => {
    const relative = source.slice(modules.length).replace(/^\/+/, '');
    if (!relative) return true;
    const segments = relative.split(sep);
    if (segments[0] === '.bin' || segments[0] === '.cache') return false;
    if (
      segments[0] === 'electron' ||
      segments[0] === '@electron' ||
      segments[0] === '@rgb-exchange'
    )
      return false;
    return true;
  },
});
mkdirSync(resolve(stage, 'node_modules/@rgb-exchange'), { recursive: true });
cpSync(
  resolve(stage, 'packages/contracts'),
  resolve(stage, 'node_modules/@rgb-exchange/contracts'),
  { recursive: true },
);
const built = await packager({
  dir: stage,
  name: 'palka',
  platform: 'darwin',
  arch: process.arch as 'arm64' | 'x64',
  out: output,
  overwrite: true,
  asar: false,
  prune: false,
  electronVersion: '44.9.0',
  appBundleId: 'com.palka.desktop',
  protocols: [{ name: 'palka offer', schemes: ['palka'] }],
  quiet: true,
});
if (!built.length) throw new Error('No desktop application was produced');
console.log(`Desktop app: ${resolve(built[0], 'palka.app')}`);
