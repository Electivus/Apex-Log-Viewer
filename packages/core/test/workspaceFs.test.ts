import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  AppenderClosedError,
  isIgnorableDirectorySyncError,
  judgeLease,
  LeaseUnreadableError,
  openDurableAppender,
  orgDirectory,
  pidLiveness,
  safeUsername,
  syncDirectory,
  tryAcquireLease,
  writeFileAtomic,
  type Lease,
  type LeaseAttempt,
  type LeaseOwner,
  type PidLiveness
} from '../src/localStore/workspaceFs.ts';

const fsp = fs.promises;

type FileHandle = Awaited<ReturnType<typeof fsp.open>>;

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alv-workspace-fs-'));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/**
 * Records every open, rename, link and FileHandle flush as `<op> <basename>`, in call order, so a
 * test can assert when bytes and names reach the disk. Temporary files are labelled `tmp`.
 */
function recordDiskCalls(t: TestContext): { calls: string[]; handles: Map<string, FileHandle> } {
  const calls: string[] = [];
  const handles = new Map<string, FileHandle>();
  const label = (file: fs.PathLike): string => {
    const name = path.basename(String(file));
    return name.endsWith('.tmp') ? 'tmp' : name;
  };
  const originalOpen = fsp.open;
  t.mock.method(fsp, 'open', async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
    const handle = await originalOpen.call(fsp, file, flags, mode);
    const name = label(file);
    calls.push(`open ${name} ${String(flags ?? 'r')}`);
    handles.set(name, handle);
    for (const op of ['appendFile', 'datasync', 'sync', 'close'] as const) {
      const original = handle[op] as (...args: unknown[]) => Promise<unknown>;
      Object.defineProperty(handle, op, {
        configurable: true,
        value: (...args: unknown[]) => {
          calls.push(`${op} ${name}`);
          return original.apply(handle, args);
        }
      });
    }
    return handle;
  });
  for (const op of ['rename', 'link'] as const) {
    const original = fsp[op];
    t.mock.method(fsp, op, (from: fs.PathLike, to: fs.PathLike) => {
      calls.push(`${op} ${label(to)}`);
      return original.call(fsp, from, to);
    });
  }
  return { calls, handles };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

function leaseOwner(overrides: Partial<LeaseOwner>): LeaseOwner {
  return {
    version: 1,
    pid: process.pid,
    token: '0123456789abcdef',
    host: os.hostname(),
    surface: 'cli',
    startedAt: '2026-10-30T00:00:00.000Z',
    ...overrides
  };
}

const isAcquired = (attempt: LeaseAttempt): attempt is { acquired: Lease } => 'acquired' in attempt;

test('directory sync policy: win32 ignores EPERM, EISDIR, EINVAL and ENOTSUP only; other platforms ignore nothing', () => {
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  for (const code of ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP']) {
    assert.equal(isIgnorableDirectorySyncError(coded(code), 'win32'), true, `win32 ignores ${code}`);
    for (const platform of ['linux', 'darwin'] as const) {
      assert.equal(isIgnorableDirectorySyncError(coded(code), platform), false, `${platform} rethrows ${code}`);
    }
  }
  for (const code of ['EACCES', 'ENOENT', 'EIO', 'ENOSPC']) {
    assert.equal(isIgnorableDirectorySyncError(coded(code), 'win32'), false, `win32 rethrows ${code}`);
  }
  assert.equal(isIgnorableDirectorySyncError('EPERM', 'win32'), false, 'a non-Error is never ignorable');
  assert.equal(
    isIgnorableDirectorySyncError(new Error('no code'), 'win32'),
    false,
    'an Error without a code is never ignorable'
  );
});

test('syncDirectory flushes a real directory and rejects a missing one on linux and on win32', async () => {
  await withWorkspace(async root => {
    await syncDirectory(root);
    await assert.rejects(syncDirectory(path.join(root, 'missing'), 'linux'), { code: 'ENOENT' });
    await assert.rejects(syncDirectory(path.join(root, 'missing'), 'win32'), { code: 'ENOENT' });
  });
});

test('writeFileAtomic flushes the temp file and the directory only when asked, after the rename or the link', async t => {
  await withWorkspace(async root => {
    const { calls } = recordDiskCalls(t);
    const directory = path.basename(root);
    const flushes = (): string[] => calls.filter(call => /^(datasync|sync|rename|link) /.test(call));
    const replaced = path.join(root, 'checkpoint.json');

    assert.equal(await writeFileAtomic(replaced, 'one\n', false), true);
    assert.deepEqual(flushes(), ['rename checkpoint.json'], 'the lifecycle keeps a plain rename');
    calls.length = 0;

    assert.equal(await writeFileAtomic(replaced, 'two\n', false, { syncDirectory: true }), true);
    assert.deepEqual(flushes(), ['datasync tmp', 'rename checkpoint.json', `sync ${directory}`]);
    assert.equal(await fsp.readFile(replaced, 'utf8'), 'two\n');
    calls.length = 0;

    const created = path.join(root, 'format.json');
    assert.equal(await writeFileAtomic(created, '{"version":1}\n', true, { syncDirectory: true }), true);
    assert.deepEqual(flushes(), ['datasync tmp', 'link format.json', `sync ${directory}`]);
    calls.length = 0;

    assert.equal(await writeFileAtomic(created, '{"version":2}\n', true, { syncDirectory: true }), false);
    assert.equal(calls.includes(`sync ${directory}`), false, 'an existing file leaves nothing new to make durable');
    assert.equal(await fsp.readFile(created, 'utf8'), '{"version":1}\n');
  });
});

test('durable appender hands every append to datasync and fsyncs the directory once, when it creates the file', async t => {
  await withWorkspace(async root => {
    const { calls } = recordDiskCalls(t);
    const file = path.join(root, 'apexlogs', 'orgs', 'u', 'events', 'App_Log__e', '2026-10-30', '09.deadbeef.ndjson');
    const flushes = (): string[] => calls.filter(call => /^(appendFile|datasync|sync) /.test(call));

    const appender = await openDurableAppender(root, file);
    await appender.append('{"n":1}\n');
    await appender.append('{"n":2}\n');
    await appender.close();
    assert.deepEqual(flushes(), [
      'sync 2026-10-30',
      'appendFile 09.deadbeef.ndjson',
      'datasync 09.deadbeef.ndjson',
      'appendFile 09.deadbeef.ndjson',
      'datasync 09.deadbeef.ndjson'
    ]);
    assert.equal(await fsp.readFile(file, 'utf8'), '{"n":1}\n{"n":2}\n');
    calls.length = 0;

    const reopened = await openDurableAppender(root, file);
    await reopened.append('{"n":3}\n');
    await reopened.close();
    assert.deepEqual(flushes(), ['appendFile 09.deadbeef.ndjson', 'datasync 09.deadbeef.ndjson']);
    assert.equal(await fsp.readFile(file, 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n');
  });
});

test('a failed append closes the appender: the torn tail is never followed by more bytes and later appends throw', async t => {
  await withWorkspace(async root => {
    const { calls, handles } = recordDiskCalls(t);
    const file = path.join(root, 'apexlogs', 'events', '10.cafef00d.ndjson');
    const appender = await openDurableAppender(root, file);
    const handle = handles.get('10.cafef00d.ndjson');
    assert.ok(handle);
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    Object.defineProperty(handle, 'appendFile', {
      configurable: true,
      value: async (text: string) => {
        await handle.write(text.slice(0, 7));
        throw diskFull;
      }
    });

    await assert.rejects(appender.append('{"n":1,"message":"torn"}\n'), diskFull);
    await assert.rejects(appender.append('{"n":2}\n'), AppenderClosedError);
    await appender.close();
    await appender.close();

    assert.equal(await fsp.readFile(file, 'utf8'), '{"n":1,');
    assert.equal(calls.includes('datasync 10.cafef00d.ndjson'), false);
    assert.equal(calls.filter(call => call === 'close 10.cafef00d.ndjson').length, 1);
  });
});

test('durable appender queues concurrent appends in call order, so lines never interleave, and close waits for them', async () => {
  await withWorkspace(async root => {
    const file = path.join(root, 'apexlogs', 'events', '11.beefbeef.ndjson');
    const appender = await openDurableAppender(root, file);
    const line = (letter: string): string => `${letter.repeat(3_000_000)}\n`;

    const pending = [appender.append(line('a')), appender.append(line('b'))];
    await appender.close();
    await Promise.all(pending);

    assert.equal(await fsp.readFile(file, 'utf8'), line('a') + line('b'));
    await assert.rejects(appender.append('{"n":3}\n'), AppenderClosedError);
  });
});

test('durable appender refuses a symlink, a dangling symlink and a path outside the workspace', async t => {
  await withWorkspace(async root => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'alv-workspace-fs-outside-'));
    try {
      const target = path.join(outside, 'target.ndjson');
      await fsp.writeFile(target, 'kept\n', 'utf8');
      const events = path.join(root, 'apexlogs', 'events');
      await fsp.mkdir(events, { recursive: true });
      try {
        await fsp.symlink(target, path.join(events, 'link.ndjson'), 'file');
        await fsp.symlink(path.join(outside, 'never-created.ndjson'), path.join(events, 'dangling.ndjson'), 'file');
      } catch {
        t.skip('filesystem does not permit symlink creation');
        return;
      }

      await assert.rejects(openDurableAppender(root, path.join(events, 'link.ndjson')), /must be a regular file/);
      assert.equal(await fsp.readFile(target, 'utf8'), 'kept\n');
      await assert.rejects(openDurableAppender(root, path.join(events, 'dangling.ndjson')), /must be a regular file/);
      assert.equal(fs.existsSync(path.join(outside, 'never-created.ndjson')), false);
      await assert.rejects(
        openDurableAppender(root, path.join(outside, 'escape.ndjson')),
        /escapes the workspace root/
      );
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

test('lease: acquire writes the owner, a second attempt in this process is held by the alive pid, release frees it', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'orgs', 'u', 'events', 'App_Log__e', 'capture.lease');
    const first = await tryAcquireLease(root, leasePath, 'vscode');
    assert.ok(isAcquired(first));
    const { owner } = first.acquired;
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, os.hostname());
    assert.equal(owner.surface, 'vscode');
    assert.match(owner.token, /^[0-9a-f]{16}$/);
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), owner);
    assert.equal(await first.acquired.stillHeld(), true);

    assert.deepEqual(await tryAcquireLease(root, leasePath, 'cli'), { heldBy: owner });
    assert.equal(await first.acquired.stillHeld(), true);

    await first.acquired.release();
    await first.acquired.release();
    assert.equal(await first.acquired.stillHeld(), false);
    assert.equal(fs.existsSync(leasePath), false);
    const next = await tryAcquireLease(root, leasePath, 'cli');
    assert.ok(isAcquired(next));
    assert.notEqual(next.acquired.owner.token, owner.token);
  });
});

test('lease: a holder on another host keeps the lease even when its pid is dead here', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const elsewhere = leaseOwner({ host: 'another-host', pid: await exitedPid() });
    await fsp.writeFile(leasePath, JSON.stringify(elsewhere), 'utf8');

    assert.deepEqual(await tryAcquireLease(root, leasePath, 'cli'), { heldBy: elsewhere });
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), elsewhere);
  });
});

test('lease: a dead pid on this host is reclaimed, and two racing reclaimers produce one winner', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const deadPid = await exitedPid();
    assert.equal(pidLiveness(deadPid), 'dead');
    assert.equal(pidLiveness(process.pid), 'alive');
    await fsp.writeFile(leasePath, JSON.stringify(leaseOwner({ pid: deadPid })), 'utf8');

    const attempts = await Promise.all([
      tryAcquireLease(root, leasePath, 'vscode'),
      tryAcquireLease(root, leasePath, 'cli')
    ]);
    const winners = attempts.filter(isAcquired);
    const losers = attempts.filter(attempt => !isAcquired(attempt));
    assert.equal(winners.length, 1);
    const winner = winners[0]?.acquired;
    assert.ok(winner);
    assert.deepEqual(losers, [{ heldBy: winner.owner }]);
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), winner.owner);
    assert.equal(await winner.stillHeld(), true);
    assert.deepEqual(
      await fsp.readdir(path.dirname(leasePath)),
      ['capture.lease'],
      'no election marker is left behind'
    );
  });
});

test('lease: a dead holder whose election marker was left by a crashed elector is still reclaimed', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const deadPid = await exitedPid();
    const holder = leaseOwner({ pid: deadPid, token: 'aaaaaaaaaaaaaaaa' });
    const crashedElector = leaseOwner({ pid: deadPid, token: 'bbbbbbbbbbbbbbbb' });
    await fsp.writeFile(leasePath, JSON.stringify(holder), 'utf8');
    await fsp.writeFile(`${leasePath}.reclaim-${holder.token}`, JSON.stringify(crashedElector), 'utf8');

    const attempt = await tryAcquireLease(root, leasePath, 'cli');

    assert.ok(isAcquired(attempt));
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), attempt.acquired.owner);
    assert.deepEqual(await fsp.readdir(path.dirname(leasePath)), ['capture.lease']);
  });
});

test('lease: the marker of a crashed elector is never deleted while a live elector runs the next election', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const deadPid = await exitedPid();
    const holder = leaseOwner({ pid: deadPid, token: 'aaaaaaaaaaaaaaaa' });
    const marker = `${leasePath}.reclaim-${holder.token}`;
    const markers = {
      [marker]: JSON.stringify(leaseOwner({ pid: deadPid, token: 'bbbbbbbbbbbbbbbb' })),
      [`${marker}-bbbbbbbbbbbbbbbb`]: JSON.stringify(leaseOwner({ pid: deadPid, token: 'cccccccccccccccc' })),
      [`${marker}-cccccccccccccccc`]: JSON.stringify(leaseOwner({ token: 'dddddddddddddddd' }))
    };
    await fsp.writeFile(leasePath, JSON.stringify(holder), 'utf8');
    for (const [file, record] of Object.entries(markers)) await fsp.writeFile(file, record, 'utf8');

    assert.deepEqual(await tryAcquireLease(root, leasePath, 'cli'), { heldBy: holder });
    for (const [file, record] of Object.entries(markers)) assert.equal(await fsp.readFile(file, 'utf8'), record);
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), holder);
  });
});

test('lease: a dead holder behind a chain of crashed electors is reclaimed, and their markers go with it', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const deadPid = await exitedPid();
    const holder = leaseOwner({ pid: deadPid, token: 'aaaaaaaaaaaaaaaa' });
    await fsp.writeFile(leasePath, JSON.stringify(holder), 'utf8');
    await fsp.writeFile(
      `${leasePath}.reclaim-aaaaaaaaaaaaaaaa`,
      JSON.stringify(leaseOwner({ pid: deadPid, token: 'bbbbbbbbbbbbbbbb' })),
      'utf8'
    );
    await fsp.writeFile(
      `${leasePath}.reclaim-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb`,
      JSON.stringify(leaseOwner({ pid: deadPid, token: 'cccccccccccccccc' })),
      'utf8'
    );

    const attempt = await tryAcquireLease(root, leasePath, 'cli');

    if (!isAcquired(attempt)) assert.fail(`expected the lease, got ${JSON.stringify(attempt)}`);
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), attempt.acquired.owner);
    assert.deepEqual(await fsp.readdir(path.dirname(leasePath)), ['capture.lease']);
  });
});

test('lease: a dead holder stays held while its election marker belongs to a live elector', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const holder = leaseOwner({ pid: await exitedPid(), token: 'aaaaaaaaaaaaaaaa' });
    const electorRecord = JSON.stringify(leaseOwner({ token: 'bbbbbbbbbbbbbbbb' }));
    const markerPath = `${leasePath}.reclaim-${holder.token}`;
    await fsp.writeFile(leasePath, JSON.stringify(holder), 'utf8');
    await fsp.writeFile(markerPath, electorRecord, 'utf8');

    assert.deepEqual(await tryAcquireLease(root, leasePath, 'cli'), { heldBy: holder });
    assert.equal(await fsp.readFile(markerPath, 'utf8'), electorRecord);
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), holder);
  });
});

const LEASE_OBSERVER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const stop = new Int32Array(workerData.stop);
let seen = 0;
let unparseable = 0;
while (Atomics.load(stop, 0) === 0) {
  let content;
  try {
    content = fs.readFileSync(workerData.leasePath, 'utf8');
  } catch {
    continue;
  }
  seen++;
  try {
    JSON.parse(content);
  } catch {
    unparseable++;
  }
}
parentPort.postMessage({ seen, unparseable });
`;

test('lease: a reader polling the lease path never sees a half-written lease while holders come and go', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const observer = new Worker(LEASE_OBSERVER, { eval: true, workerData: { leasePath, stop: stop.buffer } });
    const observed = new Promise<{ seen: number; unparseable: number }>((resolve, reject) => {
      observer.once('message', resolve);
      observer.once('error', reject);
    });

    for (let round = 0; round < 300; round++) {
      const attempt = await tryAcquireLease(root, leasePath, 'cli');
      assert.ok(isAcquired(attempt));
      await attempt.acquired.release();
    }
    Atomics.store(stop, 0, 1);

    const { seen, unparseable } = await observed;
    assert.ok(seen > 0, 'the reader saw the lease at least once');
    assert.equal(unparseable, 0);
  });
});

test('lease: an unreadable lease file throws a typed error naming the file and is left alone', async t => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    await fsp.mkdir(path.dirname(leasePath), { recursive: true });
    const unreadable = [
      'not json',
      JSON.stringify({ version: 1, pid: process.pid, token: 'xyz' }),
      JSON.stringify(leaseOwner({ surface: 'robot' as 'cli' }))
    ];
    for (const content of unreadable) {
      await fsp.writeFile(leasePath, content, 'utf8');
      await assert.rejects(
        tryAcquireLease(root, leasePath, 'cli'),
        (error: unknown) => error instanceof LeaseUnreadableError && error.leasePath === leasePath
      );
      assert.equal(await fsp.readFile(leasePath, 'utf8'), content);
    }

    await fsp.unlink(leasePath);
    try {
      await fsp.symlink(path.join(root, 'elsewhere'), leasePath, 'file');
    } catch {
      t.skip('filesystem does not permit symlink creation');
      return;
    }
    await assert.rejects(tryAcquireLease(root, leasePath, 'cli'), LeaseUnreadableError);
  });
});

test('lease: stillHeld is false once the file names another token, and release then leaves that file alone', async () => {
  await withWorkspace(async root => {
    const leasePath = path.join(root, 'apexlogs', 'capture.lease');
    const attempt = await tryAcquireLease(root, leasePath, 'vscode');
    assert.ok(isAcquired(attempt));
    const usurper = leaseOwner({ token: 'fedcba9876543210' });
    await fsp.writeFile(leasePath, JSON.stringify(usurper), 'utf8');

    assert.equal(await attempt.acquired.stillHeld(), false);
    await attempt.acquired.release();
    assert.deepEqual(JSON.parse(await fsp.readFile(leasePath, 'utf8')), usurper);

    await fsp.unlink(leasePath);
    assert.equal(await attempt.acquired.stillHeld(), false);
  });
});

test('judgeLease reclaims only a dead pid on this host', () => {
  const here = (liveness: PidLiveness) => ({ host: 'laptop', pidAlive: () => liveness });
  assert.equal(judgeLease(leaseOwner({ host: 'laptop' }), here('dead')), 'reclaim');
  assert.equal(judgeLease(leaseOwner({ host: 'laptop' }), here('alive')), 'held');
  assert.equal(judgeLease(leaseOwner({ host: 'laptop' }), here('unknown')), 'held');
  assert.equal(judgeLease(leaseOwner({ host: 'desktop' }), here('dead')), 'held');
});

test('orgDirectory keys every store by the safe username the Apex log lifecycle uses', () => {
  assert.equal(safeUsername('user@example.com'), 'user@example.com');
  assert.equal(safeUsername(' user name/with:odd chars '), 'user_name_with_odd_chars');
  for (const value of [undefined, '', '   ', '.', '..']) assert.equal(safeUsername(value), 'default');
  assert.equal(orgDirectory('/repo', 'user@example.com'), path.join('/repo', 'apexlogs', 'orgs', 'user@example.com'));
  assert.equal(orgDirectory('/repo', '../../etc'), path.join('/repo', 'apexlogs', 'orgs', '.._.._etc'));
});
