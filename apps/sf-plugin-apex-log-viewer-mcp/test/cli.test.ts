import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs, runCli } from '../src/cli.js';

test('parseArgs: --help toggles showHelp', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.showHelp, true);
  assert.equal(result.error, undefined);
});

test('parseArgs: unknown flag returns error', () => {
  const result = parseArgs(['--nope']);
  assert.ok(result.error?.includes('Unknown argument'));
});

test('parseArgs: --project-dir requires value', () => {
  const result = parseArgs(['--project-dir']);
  assert.ok(result.error?.includes('--project-dir'));
});

test('runCli: sets cwd and spawns server', async () => {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];

  const result = await runCli(['--project-dir', '/tmp/proj', '--sf-bin', '/usr/local/bin/sf'], {
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      return { once: (_: string, cb: () => void) => cb() } as any;
    },
    chdir: () => {},
    log: () => {},
    exit: () => {}
  });

  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(path.basename(calls[0].args[0]).includes('index.js'));
});
