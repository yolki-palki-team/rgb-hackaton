import type { ChildProcess } from 'node:child_process';

export async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
    child.kill('SIGTERM');
  });
}

export async function stopWalletServices(
  backend: ChildProcess | null,
  sidecar: ChildProcess | null,
): Promise<void> {
  // Let the local service finish persisting any in-flight wallet response first.
  await stopChild(backend);
  await stopChild(sidecar);
}
