import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

test('stdio server stays alive after startup', async () => {
  const entry = path.join(process.cwd(), 'src/index.ts');
  const child = spawn('node', ['--import', 'tsx', entry], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: process.env
  });

  const exitedEarly = await waitForExit(child, 200);
  child.kill('SIGTERM');
  await waitForExit(child, 200);

  assert.equal(exitedEarly, false);
});
