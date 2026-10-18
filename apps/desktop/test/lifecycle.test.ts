import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { stopChild, stopWalletServices } from '../src/lifecycle.ts';

test('desktop shutdown waits for backend persistence before stopping the wallet', async () => {
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80)); console.log('ready'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  try {
    await Promise.all(children.map((child) => once(child.stdout!, 'data')));
    const [backend, wallet] = children;
    backend.once('exit', () => assert.equal(wallet.killed, false));
    await stopWalletServices(backend, wallet);
    assert.equal(backend.exitCode, 0);
    assert.equal(wallet.exitCode, 0);
    await stopChild(wallet);
    await stopChild(null);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }
});
