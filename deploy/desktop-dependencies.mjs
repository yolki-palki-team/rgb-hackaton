import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function ensureDependencies(
  root,
  install = () => {
    const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Locked Node dependency installation failed');
    // The pinned Electron package ships its installer without a postinstall script.
    const electron = spawnSync(process.execPath, [join(root, 'node_modules/electron/install.js')], {
      cwd: root,
      stdio: 'inherit',
    });
    if (electron.error) throw electron.error;
    if (electron.status !== 0) throw new Error('Electron runtime installation failed');
  },
) {
  const lock = readFileSync(join(root, 'package-lock.json'));
  const manifestPaths = Object.keys(JSON.parse(lock).packages)
    .filter((path) => !path.split('/').includes('node_modules'))
    .map((path) => join(path, 'package.json'))
    .sort();
  const hash = createHash('sha256').update(lock);
  hash.update(JSON.stringify([process.platform, process.arch, process.version]));
  for (const path of [...manifestPaths, '.nvmrc', '.npmrc']) {
    hash.update(path);
    hash.update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : '<missing>');
  }
  const fingerprint = hash.digest('hex');
  const marker = join(root, 'node_modules/.palka-desktop-dependencies');
  const runtimePresent = () => {
    const modules = join(root, 'node_modules');
    if (
      ![
        '.package-lock.json',
        'tsx/package.json',
        'vite/package.json',
        'node/bin/node',
        'electron/path.txt',
      ].every((path) => existsSync(join(modules, path)))
    )
      return false;
    const executable = readFileSync(join(modules, 'electron/path.txt'), 'utf8').trim();
    return Boolean(executable) && existsSync(join(modules, 'electron/dist', executable));
  };
  if (
    existsSync(marker) &&
    readFileSync(marker, 'utf8').trim() === fingerprint &&
    runtimePresent()
  ) {
    console.log('Node dependencies unchanged; reusing the installed runtime.');
    return false;
  }
  install();
  if (!runtimePresent()) throw new Error('Node or Electron runtime is incomplete after npm ci');
  writeFileSync(marker, fingerprint + '\n');
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  ensureDependencies(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
