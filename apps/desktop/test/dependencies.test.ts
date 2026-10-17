import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('desktop reuses locked dependencies, invalidates changed manifests, and repairs missing runtimes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['deploy', 'bin', 'apps/client'])
    mkdirSync(join(root, directory), { recursive: true });
  cpSync(
    new URL('../../../deploy/desktop-dependencies.mjs', import.meta.url),
    join(root, 'deploy/desktop-dependencies.mjs'),
  );
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'apps/client/package.json'), '{}');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ packages: { '': {}, 'apps/client': {}, 'node_modules/react': {} } }),
  );
  writeFileSync(
    join(root, 'bin/npm'),
    `#!/bin/sh
echo "$*" >> installs.log
if [ -f fail-install ]; then exit 1; fi
mkdir -p node_modules/tsx node_modules/vite node_modules/node/bin node_modules/electron/dist
touch node_modules/.package-lock.json node_modules/tsx/package.json node_modules/vite/package.json node_modules/node/bin/node node_modules/electron/dist/test-electron
echo test-electron > node_modules/electron/path.txt
`,
    { mode: 0o755 },
  );
  const launch = () =>
    spawnSync(process.execPath, [join(root, 'deploy/desktop-dependencies.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH },
    });
  const installs = () => readFileSync(join(root, 'installs.log'), 'utf8').trim().split('\n').length;
  const success = () => {
    const result = launch();
    assert.equal(result.status, 0, result.stderr);
  };
  success();
  success();
  assert.equal(installs(), 1, 'unchanged restarts must not reinstall');
  writeFileSync(join(root, 'apps/client/package.json'), '{"version":"2"}');
  success();
  assert.equal(installs(), 2, 'workspace manifest changes invalidate the install');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      packages: { '': {}, 'apps/client': {}, 'node_modules/react': { version: '2' } },
    }),
  );
  success();
  assert.equal(installs(), 3, 'lockfile changes invalidate the install');
  rmSync(join(root, 'node_modules/electron/dist/test-electron'));
  success();
  assert.equal(installs(), 4, 'missing Electron executable must be repaired');
  rmSync(join(root, 'node_modules/.palka-desktop-dependencies'));
  writeFileSync(join(root, 'fail-install'), '');
  assert.notEqual(launch().status, 0);
  assert.equal(
    existsSync(join(root, 'node_modules/.palka-desktop-dependencies')),
    false,
    'failed installs must not be cached',
  );
});
