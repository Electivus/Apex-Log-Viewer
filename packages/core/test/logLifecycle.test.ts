import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ApexLogLifecycleError,
  createApexLogLifecycle,
  type ApexLogRemote,
  type StoredApexLogBody
} from '../src/index.ts';

function unavailableRemote(calls: string[]): ApexLogRemote {
  return {
    async resolveOrg() {
      calls.push('resolveOrg');
      throw new Error('Salesforce must not be consulted');
    },
    async listLogs() {
      calls.push('listLogs');
      throw new Error('Salesforce must not be consulted');
    },
    async readBody() {
      calls.push('readBody');
      throw new Error('Salesforce must not be consulted');
    }
  };
}

test('Apex Log Lifecycle falls back to a unique legacy path when org resolution is unavailable', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-local-'));
  const logId = '07L000000000001AAA';
  const username = 'demo@example.com';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  const remoteCalls: string[] = [];

  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'legacy body', 'utf8');

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result = await lifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: username,
      log: { logId }
    });

    assert.deepEqual(result, {
      logId,
      resolvedUsername: username,
      source: 'local',
      persistence: 'existing',
      localPath: legacyPath
    });
    assert.deepEqual(remoteCalls, ['resolveOrg']);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle finds a canonical local path before consulting Salesforce', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-canonical-'));
  const logId = '07L000000000002AAA';
  const username = 'demo@example.com';
  const canonicalPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-20', `${logId}.log`);
  const remoteCalls: string[] = [];

  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fs.writeFile(canonicalPath, 'canonical body', 'utf8');
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'org.json'),
    `${JSON.stringify({ version: 1, username })}\n`,
    'utf8'
  );

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result = await lifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: username,
      log: { logId }
    });

    assert.equal(result.localPath, canonicalPath);
    assert.equal(result.persistence, 'existing');
    assert.deepEqual(remoteCalls, []);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle acquires a missing body and returns its canonical local path', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-remote-'));
  const logId = '07L000000000003AAA';
  const username = 'resolved@example.com';
  const calls: string[] = [];
  const remote: ApexLogRemote = {
    async resolveOrg(targetOrg) {
      calls.push(`resolve:${targetOrg}`);
      return { username, alias: 'demo' };
    },
    async listLogs() {
      throw new Error('listLogs is not used by requireLocalPath');
    },
    async readBody(request) {
      calls.push(`read:${request.org.username}:${request.logId}`);
      return 'remote body';
    }
  };

  const lifecycle = createApexLogLifecycle({ remote });
  try {
    const result = await lifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: 'demo',
      log: { logId, startTime: '2026-07-20T14:30:00.000Z' }
    });

    const expectedPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-20', `${logId}.log`);
    assert.deepEqual(result, {
      logId,
      startTime: '2026-07-20T14:30:00.000Z',
      resolvedUsername: username,
      source: 'remote',
      persistence: 'written',
      localPath: expectedPath
    });
    assert.equal(await fs.readFile(result.localPath, 'utf8'), 'remote body');
    assert.deepEqual(calls, ['resolve:demo', `read:${username}:${logId}`]);
    assert.deepEqual(
      (await fs.readdir(path.dirname(expectedPath))).sort(),
      [`${logId}.log`],
      'temporary files must not remain beside the canonical log'
    );
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle protects materialized workspace logs through the existing gitignore', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-gitignore-'));
  const logId = '07L000000000037AAA';
  const username = 'gitignore@example.com';
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf8');
  const lifecycle = createApexLogLifecycle({
    remote: {
      async resolveOrg() {
        return { username };
      },
      async listLogs() {
        throw new Error('listLogs is not used by requireLocalPath');
      },
      async readBody() {
        return 'sensitive Salesforce log';
      }
    }
  });

  try {
    const [result, concurrentResult] = await Promise.all([
      lifecycle.requireLocalPath({ workspaceRoot, targetOrg: username, log: { logId } }),
      lifecycle.requireLocalPath({ workspaceRoot, targetOrg: username, log: { logId } })
    ]);

    assert.equal(await fs.readFile(result.localPath, 'utf8'), 'sensitive Salesforce log');
    assert.equal(concurrentResult.localPath, result.localPath);
    assert.equal(await fs.readFile(gitignorePath, 'utf8'), 'node_modules/\napexlogs/\n');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle contains encoded org identities beneath the canonical root', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-safe-org-'));
  const logId = '07L000000000027AAA';
  const lifecycle = createApexLogLifecycle({
    remote: {
      async resolveOrg() {
        return { username: '..' };
      },
      async listLogs() {
        return [];
      },
      async readBody() {
        return 'contained body';
      }
    }
  });

  try {
    const result = await lifecycle.requireLocalPath({ workspaceRoot, targetOrg: '..', log: { logId } });
    const canonicalRoot = path.join(workspaceRoot, 'apexlogs', 'orgs');

    assert.equal(result.localPath, path.join(canonicalRoot, 'default', 'logs', 'unknown-date', `${logId}.log`));
    assert.equal(path.relative(canonicalRoot, result.localPath).startsWith('..'), false);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle reads a local body with truncation and provenance', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-read-'));
  const logId = '07L000000000004AAA';
  const username = 'reader@example.com';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  const remoteCalls: string[] = [];

  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'abcdef', 'utf8');

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result: StoredApexLogBody = await lifecycle.read({
      workspaceRoot,
      targetOrg: username,
      log: { logId },
      maxBytes: 3
    });

    assert.deepEqual(result, {
      logId,
      resolvedUsername: username,
      source: 'local',
      persistence: 'existing',
      localPath: legacyPath,
      body: 'abc',
      sizeBytes: 6,
      truncated: true
    });
    assert.deepEqual(remoteCalls, ['resolveOrg']);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle shares acquisition while cancelling callers independently', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-shared-'));
  const logId = '07L000000000005AAA';
  const username = 'shared@example.com';
  const cancelledCaller = new AbortController();
  let notifyReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>(resolve => {
    notifyReadStarted = resolve;
  });
  const readGate = new Promise<void>(resolve => {
    releaseRead = resolve;
  });
  let readCalls = 0;
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      throw new Error('listLogs is not used by requireLocalPath');
    },
    async readBody() {
      readCalls += 1;
      notifyReadStarted();
      await readGate;
      return 'shared body';
    }
  };

  const lifecycle = createApexLogLifecycle({ remote });
  try {
    const first = lifecycle.requireLocalPath(
      { workspaceRoot, targetOrg: 'shared', log: { logId } },
      { signal: cancelledCaller.signal }
    );
    const second = lifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: 'shared',
      log: { logId }
    });

    await readStarted;
    cancelledCaller.abort();
    releaseRead();

    await assert.rejects(first, error => error instanceof ApexLogLifecycleError && error.code === 'cancelled');
    const result = await second;
    assert.equal(await fs.readFile(result.localPath, 'utf8'), 'shared body');
    assert.equal(readCalls, 1);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle keeps the first complete body when independent writers race', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-writer-race-'));
  const username = 'race@example.com';
  const logId = '07L000000000034AAA';
  let releaseWriters!: () => void;
  const writerGate = new Promise<void>(resolve => {
    releaseWriters = resolve;
  });
  const createRemote = (body: string): ApexLogRemote => ({
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return [];
    },
    async readBody() {
      await writerGate;
      return body;
    }
  });
  const first = createApexLogLifecycle({ remote: createRemote('first complete body') });
  const second = createApexLogLifecycle({ remote: createRemote('second complete body') });

  try {
    const requests = [first, second].map(lifecycle =>
      lifecycle.requireLocalPath({ workspaceRoot, targetOrg: username, log: { logId } })
    );
    releaseWriters();
    const results = await Promise.all(requests);

    assert.deepEqual(results.map(result => result.persistence).sort(), ['existing', 'written']);
    assert.ok(
      ['first complete body', 'second complete body'].includes(await fs.readFile(results[0]!.localPath, 'utf8'))
    );
  } finally {
    first.dispose();
    second.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Tail-style read returns a remote body when local persistence fails', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-best-effort-'));
  const logId = '07L000000000006AAA';
  const username = 'tail@example.com';
  await fs.writeFile(path.join(workspaceRoot, 'apexlogs'), 'blocks directory creation', 'utf8');

  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      throw new Error('listLogs is not used by read');
    },
    async readBody() {
      return 'tail body';
    }
  };
  const lifecycle = createApexLogLifecycle({ remote });

  try {
    const result = await lifecycle.read({
      workspaceRoot,
      targetOrg: username,
      log: { logId },
      persistence: 'best-effort'
    });

    assert.equal(result.body, 'tail body');
    assert.equal(result.source, 'remote');
    assert.equal(result.persistence, 'failed');
    assert.equal(result.localPath, undefined);
    assert.ok(result.persistenceError instanceof ApexLogLifecycleError);
    assert.equal(result.persistenceError.code, 'local-persistence');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Tail-style read returns a legacy body when canonical materialization fails', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-best-effort-local-'));
  const logId = '07L000000000026AAA';
  const username = 'tail-local@example.com';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'legacy tail body', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'apexlogs', 'orgs'), 'blocks canonical directory', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    const result = await lifecycle.read({
      workspaceRoot,
      targetOrg: username,
      log: { logId, startTime: '2026-07-20T12:00:00.000Z' },
      persistence: 'best-effort'
    });

    assert.equal(result.body, 'legacy tail body');
    assert.equal(result.source, 'local');
    assert.equal(result.persistence, 'failed');
    assert.equal(result.localPath, undefined);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle materializes a legacy body when its start time is known', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-materialize-'));
  const logId = '07L000000000007AAA';
  const username = 'legacy@example.com';
  const startTime = '2026-07-19T23:45:00.000Z';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  const remoteCalls: string[] = [];
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'legacy materialized body', 'utf8');

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result = await lifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: username,
      log: { logId, startTime }
    });

    const expectedPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-19', `${logId}.log`);
    assert.equal(result.localPath, expectedPath);
    assert.equal(result.source, 'local');
    assert.equal(result.persistence, 'written');
    assert.equal(await fs.readFile(expectedPath, 'utf8'), 'legacy materialized body');
    assert.equal(await fs.readFile(legacyPath, 'utf8'), 'legacy materialized body');
    assert.deepEqual(remoteCalls, ['resolveOrg']);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle reports available and missing local paths without remote acquisition', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-available-'));
  const username = 'search@example.com';
  const availableId = '07L000000000008AAA';
  const missingId = '07L000000000009AAA';
  const availablePath = path.join(workspaceRoot, 'apexlogs', `${username}_${availableId}.log`);
  const remoteCalls: string[] = [];
  await fs.mkdir(path.dirname(availablePath), { recursive: true });
  await fs.writeFile(availablePath, 'searchable', 'utf8');

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result = await lifecycle.availableLocalPaths({
      workspaceRoot,
      targetOrg: username,
      logs: [{ logId: availableId }, { logId: missingId }]
    });

    assert.deepEqual(
      result.available.map(file => file.logId),
      [availableId]
    );
    assert.equal(result.available[0]?.localPath, availablePath);
    assert.deepEqual(result.missing, [{ logId: missingId }]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(remoteCalls, []);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle accepts a unique cross-org local match when no org is selected', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-unique-org-'));
  const username = 'unique@example.com';
  const logId = '07L000000000021AAA';
  const localPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-20', `${logId}.log`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'unique body', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    const result = await lifecycle.availableLocalPaths({ workspaceRoot, logs: [{ logId }] });
    assert.equal(result.available[0]?.resolvedUsername, username);
    assert.equal(result.available[0]?.localPath, localPath);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.failures, []);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle rejects an ambiguous cross-org local match', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-ambiguous-org-'));
  const logId = '07L000000000028AAA';
  for (const username of ['first@example.com', 'second@example.com']) {
    const localPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-20', `${logId}.log`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, username, 'utf8');
  }
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    await assert.rejects(
      lifecycle.requireLocalPath({ workspaceRoot, log: { logId } }),
      error => error instanceof ApexLogLifecycleError && error.code === 'org-resolution'
    );
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle treats canonical and legacy copies for one org as one local match', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-coexisting-layouts-'));
  const username = 'coexisting@example.com';
  const logId = '07L000000000025AAA';
  const canonicalPath = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-20', `${logId}.log`);
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fs.writeFile(canonicalPath, 'canonical body', 'utf8');
  await fs.writeFile(legacyPath, 'legacy body', 'utf8');
  const remoteCalls: string[] = [];
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });

  try {
    const result = await lifecycle.requireLocalPath({ workspaceRoot, log: { logId } });

    assert.equal(result.localPath, canonicalPath);
    assert.equal(result.resolvedUsername, username);
    assert.deepEqual(remoteCalls, []);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle emits structured progress and ignores observer failures', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-observer-'));
  const username = 'observer@example.com';
  const logId = '07L000000000022AAA';
  const localPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'observer body', 'utf8');
  const phases: string[] = [];
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    const result = await lifecycle.requireLocalPath(
      { workspaceRoot, targetOrg: username, log: { logId } },
      {
        observe: event => {
          phases.push(event.phase);
          if (event.phase === 'checking-local') throw new Error('observer failure');
          if (event.phase === 'completed') return Promise.reject(new Error('async observer failure'));
        }
      }
    );
    assert.equal(result.localPath, localPath);
    assert.deepEqual(phases, ['started', 'checking-local', 'resolving-org', 'completed']);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle rejects invalid log identities before any dependency work', async () => {
  const remoteCalls: string[] = [];
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    await assert.rejects(
      lifecycle.requireLocalPath({
        workspaceRoot: '/tmp/alv-invalid-log-test',
        targetOrg: 'invalid@example.com',
        log: { logId: '../not-a-log' }
      }),
      error => error instanceof ApexLogLifecycleError && error.code === 'invalid-log'
    );
    assert.deepEqual(remoteCalls, []);
  } finally {
    lifecycle.dispose();
  }
});

test('Apex Log Lifecycle sync materializes local bodies, downloads missing bodies, and advances its checkpoint', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-sync-'));
  const username = 'sync@example.com';
  const cachedId = '07L000000000010AAA';
  const remoteId = '07L000000000011AAA';
  const cachedPath = path.join(workspaceRoot, 'apexlogs', `${username}_${cachedId}.log`);
  await fs.mkdir(path.dirname(cachedPath), { recursive: true });
  await fs.writeFile(cachedPath, 'cached body', 'utf8');

  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return [
        { logId: remoteId, startTime: '2026-07-20T11:00:00.000Z' },
        { logId: cachedId, startTime: '2026-07-19T10:00:00.000Z' }
      ];
    },
    async readBody(request) {
      if (request.logId !== remoteId) throw new Error('cached body must not be downloaded');
      return 'downloaded body';
    }
  };
  const lifecycle = createApexLogLifecycle({ remote });

  try {
    const result = await lifecycle.sync({ workspaceRoot, targetOrg: 'sync', concurrency: 2 });

    assert.equal(result.status, 'success');
    assert.equal(result.resolvedUsername, username);
    assert.equal(result.materialized, 1);
    assert.equal(result.downloaded, 1);
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.checkpoint, {
      advanced: true,
      lastLogId: remoteId,
      lastStartTime: '2026-07-20T11:00:00.000Z'
    });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(workspaceRoot, 'apexlogs', '.alv', 'version.json'), 'utf8')),
      1
    );
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle status reports logical sync state without layout paths', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-status-'));
  const username = 'status@example.com';
  const logId = '07L000000000012AAA';
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return [{ logId, startTime: '2026-07-20T12:00:00.000Z' }];
    },
    async readBody() {
      return 'status body';
    }
  };
  const lifecycle = createApexLogLifecycle({ remote });

  try {
    await lifecycle.sync({ workspaceRoot, targetOrg: username });
    const status = await lifecycle.status({ workspaceRoot, targetOrg: username });

    assert.equal(status.resolvedUsername, username);
    assert.equal(status.localLogCount, 1);
    assert.equal(status.hasState, true);
    assert.equal(status.hasCheckpoint, true);
    assert.equal(status.lastSyncedLogId, logId);
    assert.deepEqual(status.lastSync, {
      existing: 0,
      materialized: 0,
      downloaded: 1,
      failed: 0
    });
    assert.equal('stateFile' in status, false);
    assert.equal('apexlogsRoot' in status, false);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle triages a local log through the shared acquisition seam', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-triage-'));
  const username = 'triage@example.com';
  const logId = '07L000000000013AAA';
  const localPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  const remoteCalls: string[] = [];
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, '12:00:00.0|FATAL_ERROR|System.NullPointerException: boom', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });

  try {
    const result = await lifecycle.triage({
      workspaceRoot,
      targetOrg: username,
      logs: [{ logId }]
    });

    assert.equal(result.entries[0]?.status, 'triaged');
    const entry = result.entries[0];
    if (entry?.status !== 'triaged') assert.fail('expected a triaged entry');
    assert.equal(entry.file.localPath, localPath);
    assert.equal(entry.summary.hasErrors, true);
    assert.equal(entry.summary.primaryReason, 'Fatal exception');
    assert.deepEqual(remoteCalls, ['resolveOrg']);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle purge removes only expired canonical files allowed by policy', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-purge-'));
  const username = 'purge@example.com';
  const expiredId = '07L000000000014AAA';
  const keptId = '07L000000000015AAA';
  const legacyId = '07L000000000016AAA';
  const logsDir = path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'logs', '2026-07-18');
  const expiredPath = path.join(logsDir, `${expiredId}.log`);
  const keptPath = path.join(logsDir, `${keptId}.log`);
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `${username}_${legacyId}.log`);
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'org.json'),
    `${JSON.stringify({ version: 1, username })}\n`,
    'utf8'
  );
  await fs.writeFile(expiredPath, 'expired', 'utf8');
  await fs.writeFile(keptPath, 'kept', 'utf8');
  await fs.writeFile(legacyPath, 'legacy', 'utf8');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(expiredPath, old, old);
  await fs.utimes(keptPath, old, old);
  await fs.utimes(legacyPath, old, old);

  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });
  try {
    const result = await lifecycle.purge({
      workspaceRoot,
      targetOrg: username,
      policy: { maxAgeMs: 60 * 60 * 1000, keepLogIds: [keptId] }
    });

    assert.deepEqual(result, { inspected: 2, removed: 1, kept: 1, failures: [] });
    await assert.rejects(fs.access(expiredPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(await fs.readFile(keptPath, 'utf8'), 'kept');
    assert.equal(await fs.readFile(legacyPath, 'utf8'), 'legacy');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle purge ignores symlinks and unsupported cache directories', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-purge-links-'));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-purge-external-'));
  const linkedId = '07L000000000029AAA';
  const unsupportedId = '07L000000000030AAA';
  const linkedRootId = '07L000000000031AAA';
  const externalPath = path.join(externalRoot, `${linkedId}.log`);
  const externalDayPath = path.join(externalRoot, '2026-07-20', `${linkedRootId}.log`);
  const validDay = path.join(workspaceRoot, 'apexlogs', 'orgs', 'safe@example.com', 'logs', '2026-07-20');
  const unsupportedPath = path.join(
    workspaceRoot,
    'apexlogs',
    'orgs',
    'safe@example.com',
    'logs',
    'not-a-day',
    `${unsupportedId}.log`
  );
  await fs.mkdir(validDay, { recursive: true });
  await fs.mkdir(path.dirname(unsupportedPath), { recursive: true });
  await fs.mkdir(path.dirname(externalDayPath), { recursive: true });
  const linkedOrgRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', 'linked@example.com');
  await fs.mkdir(linkedOrgRoot, { recursive: true });
  for (const username of ['safe@example.com', 'linked@example.com']) {
    await fs.writeFile(
      path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'org.json'),
      `${JSON.stringify({ version: 1, username })}\n`,
      'utf8'
    );
  }
  await fs.writeFile(externalPath, 'external', 'utf8');
  await fs.writeFile(externalDayPath, 'external through linked logs root', 'utf8');
  await fs.writeFile(unsupportedPath, 'unsupported', 'utf8');
  try {
    await fs.symlink(externalPath, path.join(validDay, `${linkedId}.log`), 'file');
    await fs.symlink(externalRoot, path.join(linkedOrgRoot, 'logs'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) {
      t.skip('filesystem does not permit symlink creation');
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(externalRoot, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    const safeResult = await lifecycle.purge({
      workspaceRoot,
      targetOrg: 'safe@example.com',
      policy: { maxAgeMs: 0 }
    });
    const linkedResult = await lifecycle.purge({
      workspaceRoot,
      targetOrg: 'linked@example.com',
      policy: { maxAgeMs: 0 }
    });

    assert.deepEqual(safeResult, { inspected: 0, removed: 0, kept: 0, failures: [] });
    assert.deepEqual(linkedResult, { inspected: 0, removed: 0, kept: 0, failures: [] });
    assert.equal(await fs.readFile(externalPath, 'utf8'), 'external');
    assert.equal(await fs.readFile(externalDayPath, 'utf8'), 'external through linked logs root');
    assert.equal(await fs.readFile(unsupportedPath, 'utf8'), 'unsupported');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle purge rejects cancellation before traversal', async () => {
  const controller = new AbortController();
  controller.abort();
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    await assert.rejects(
      lifecycle.purge(
        { workspaceRoot: path.resolve('/tmp/alv-lifecycle-cancelled-purge'), policy: { maxAgeMs: 0 } },
        { signal: controller.signal }
      ),
      error => error instanceof ApexLogLifecycleError && error.code === 'cancelled'
    );
  } finally {
    lifecycle.dispose();
  }
});

test('Apex Log Lifecycle purge resolves the default org instead of traversing every org', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-purge-default-'));
  const defaultUsername = 'default-purge@example.com';
  const otherUsername = 'other-purge@example.com';
  const defaultId = '07L000000000038AAA';
  const otherId = '07L000000000039AAA';
  const createCanonical = async (username: string, logId: string): Promise<string> => {
    const orgRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', username);
    const localPath = path.join(orgRoot, 'logs', '2026-07-20', `${logId}.log`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, username, 'utf8');
    await fs.writeFile(path.join(orgRoot, 'org.json'), `${JSON.stringify({ version: 1, username })}\n`, 'utf8');
    return localPath;
  };
  const defaultPath = await createCanonical(defaultUsername, defaultId);
  const otherPath = await createCanonical(otherUsername, otherId);
  const resolvedSelectors: Array<string | undefined> = [];
  const lifecycle = createApexLogLifecycle({
    remote: {
      async resolveOrg(targetOrg) {
        resolvedSelectors.push(targetOrg);
        return { username: defaultUsername };
      },
      async listLogs() {
        return [];
      },
      async readBody() {
        return '';
      }
    }
  });

  try {
    const result = await lifecycle.purge({ workspaceRoot, policy: { maxAgeMs: 0 } });

    assert.deepEqual(resolvedSelectors, [undefined]);
    assert.deepEqual(result, { inspected: 1, removed: 1, kept: 0, failures: [] });
    await assert.rejects(fs.access(defaultPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(await fs.readFile(otherPath, 'utf8'), otherUsername);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle does not treat an unresolved purge selector as storage identity', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-purge-selector-'));
  const selector = 'unresolved-alias';
  const logId = '07L000000000032AAA';
  const localPath = path.join(workspaceRoot, 'apexlogs', 'orgs', selector, 'logs', '2026-07-20', `${logId}.log`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'must remain', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    await assert.rejects(
      lifecycle.purge({ workspaceRoot, targetOrg: selector, policy: { maxAgeMs: 0 } }),
      error => error instanceof ApexLogLifecycleError && error.code === 'org-resolution'
    );
    assert.equal(await fs.readFile(localPath, 'utf8'), 'must remain');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle persists org identity so aliases work offline', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-alias-'));
  const username = 'alias-user@example.com';
  const alias = 'demo';
  const logId = '07L000000000017AAA';
  const online = createApexLogLifecycle({
    remote: {
      async resolveOrg() {
        return { username, alias, instanceUrl: 'https://example.my.salesforce.com' };
      },
      async listLogs() {
        return [{ logId, startTime: '2026-07-20T12:00:00.000Z' }];
      },
      async readBody() {
        return 'offline body';
      }
    }
  });

  try {
    await online.sync({ workspaceRoot, targetOrg: alias });
  } finally {
    online.dispose();
  }

  const remoteCalls: string[] = [];
  const offline = createApexLogLifecycle({ remote: unavailableRemote(remoteCalls) });
  try {
    const result = await offline.requireLocalPath({
      workspaceRoot,
      targetOrg: alias,
      log: { logId }
    });

    assert.equal(result.resolvedUsername, username);
    assert.equal(await fs.readFile(result.localPath, 'utf8'), 'offline body');
    assert.deepEqual(remoteCalls, []);
    const metadata = JSON.parse(
      await fs.readFile(path.join(workspaceRoot, 'apexlogs', 'orgs', username, 'org.json'), 'utf8')
    );
    assert.deepEqual(metadata, {
      version: 1,
      username,
      targetOrg: alias,
      safeTargetOrg: username,
      resolvedUsername: username,
      alias,
      instanceUrl: 'https://example.my.salesforce.com',
      updatedAt: metadata.updatedAt
    });
    assert.equal(typeof metadata.updatedAt, 'string');
  } finally {
    offline.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle keeps the previous checkpoint after a partial sync', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-partial-'));
  const username = 'partial@example.com';
  const previousId = '07L000000000018AAA';
  const failingId = '07L000000000019AAA';
  const completedId = '07L000000000035AAA';
  let failing = true;
  const bodyCalls = new Map<string, number>();
  let rows = [{ logId: previousId, startTime: '2026-07-19T12:00:00.000Z' }];
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return rows;
    },
    async readBody({ logId }) {
      bodyCalls.set(logId, (bodyCalls.get(logId) ?? 0) + 1);
      if (logId === failingId && failing) throw new Error('body unavailable');
      return `body for ${logId}`;
    }
  };
  const lifecycle = createApexLogLifecycle({ remote });

  try {
    await lifecycle.sync({ workspaceRoot, targetOrg: username });
    rows = [
      { logId: failingId, startTime: '2026-07-20T12:00:00.000Z' },
      { logId: completedId, startTime: '2026-07-20T11:00:00.000Z' },
      { logId: previousId, startTime: '2026-07-19T12:00:00.000Z' }
    ];

    const result = await lifecycle.sync({ workspaceRoot, targetOrg: username });

    assert.equal(result.status, 'partial');
    assert.equal(result.failures[0]?.error.code, 'remote-acquisition');
    assert.deepEqual(result.checkpoint, {
      advanced: false,
      lastLogId: previousId,
      lastStartTime: '2026-07-19T12:00:00.000Z'
    });
    const status = await lifecycle.status({ workspaceRoot, targetOrg: username });
    assert.equal(status.lastSyncedLogId, previousId);
    assert.equal(status.lastSync.failed, 1);

    failing = false;
    const retry = await lifecycle.sync({ workspaceRoot, targetOrg: username });

    assert.equal(retry.status, 'success');
    assert.equal(retry.existing, 1);
    assert.equal(retry.downloaded, 1);
    assert.equal(bodyCalls.get(completedId), 1);
    assert.deepEqual(retry.checkpoint, {
      advanced: true,
      lastLogId: failingId,
      lastStartTime: '2026-07-20T12:00:00.000Z'
    });
    assert.equal((await lifecycle.status({ workspaceRoot, targetOrg: username })).lastSync.failed, 0);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle rolls back a checkpoint when cancellation arrives during commit', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-cancelled-checkpoint-'));
  const username = 'cancelled-checkpoint@example.com';
  const previousId = '07L000000000036AAA';
  const nextId = '07L000000000037AAA';
  let rows = [{ logId: previousId, startTime: '2026-07-19T12:00:00.000Z' }];
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return rows;
    },
    async readBody({ logId }) {
      return `body for ${logId}`;
    }
  };
  const lifecycle = createApexLogLifecycle({ remote });

  try {
    await lifecycle.sync({ workspaceRoot, targetOrg: username });
    rows = [
      { logId: nextId, startTime: '2026-07-20T12:00:00.000Z' },
      { logId: previousId, startTime: '2026-07-19T12:00:00.000Z' }
    ];
    const controller = new AbortController();

    await assert.rejects(
      lifecycle.sync(
        { workspaceRoot, targetOrg: username },
        {
          signal: controller.signal,
          observe: event => {
            if (event.operation === 'sync' && event.phase === 'completed') controller.abort();
          }
        }
      ),
      error => error instanceof ApexLogLifecycleError && error.code === 'cancelled'
    );

    const status = await lifecycle.status({ workspaceRoot, targetOrg: username });
    assert.equal(status.lastSyncedLogId, previousId);
    assert.equal(status.lastSyncedStartTime, '2026-07-19T12:00:00.000Z');
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle translates org and body failures into stable error categories', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-errors-'));
  const logId = '07L000000000020AAA';
  const resolving = createApexLogLifecycle({
    remote: {
      async resolveOrg() {
        throw new Error('sf auth failed');
      },
      async listLogs() {
        return [];
      },
      async readBody() {
        return '';
      }
    }
  });
  try {
    await assert.rejects(
      resolving.requireLocalPath({ workspaceRoot, targetOrg: 'missing', log: { logId } }),
      error =>
        error instanceof ApexLogLifecycleError &&
        error.code === 'org-resolution' &&
        error.context.operation === 'require-local-path'
    );
  } finally {
    resolving.dispose();
  }

  const acquiring = createApexLogLifecycle({
    remote: {
      async resolveOrg() {
        return { username: 'errors@example.com' };
      },
      async listLogs() {
        return [];
      },
      async readBody() {
        throw new Error('tooling body failed');
      }
    }
  });
  try {
    await assert.rejects(
      acquiring.requireLocalPath({ workspaceRoot, targetOrg: 'errors', log: { logId } }),
      error =>
        error instanceof ApexLogLifecycleError &&
        error.code === 'remote-acquisition' &&
        error.context.operation === 'require-local-path'
    );
  } finally {
    acquiring.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle reads legacy org metadata and sync-state shapes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-legacy-state-'));
  const username = 'legacy-state@example.com';
  const alias = 'legacy-state';
  const logId = '07L000000000023AAA';
  const orgRoot = path.join(workspaceRoot, 'apexlogs', 'orgs', username);
  const localPath = path.join(orgRoot, 'logs', '2026-07-20', `${logId}.log`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'legacy state body', 'utf8');
  await fs.writeFile(
    path.join(orgRoot, 'org.json'),
    JSON.stringify({
      targetOrg: alias,
      safeTargetOrg: username,
      resolvedUsername: username,
      alias,
      updatedAt: '2026-07-20T12:00:00.000Z'
    }),
    'utf8'
  );
  const statePath = path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      orgs: {
        [username]: {
          lastSyncStartedAt: '2026-07-20T11:59:00.000Z',
          lastSyncCompletedAt: '2026-07-20T12:00:00.000Z',
          lastSyncedLogId: logId,
          lastSyncedStartTime: '2026-07-20T11:58:00.000Z',
          downloadedCount: 2,
          cachedCount: 3
        }
      }
    }),
    'utf8'
  );

  const calls: string[] = [];
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote(calls) });
  try {
    const file = await lifecycle.requireLocalPath({ workspaceRoot, targetOrg: alias, log: { logId } });
    const status = await lifecycle.status({ workspaceRoot, targetOrg: alias });

    assert.equal(file.localPath, localPath);
    assert.equal(file.resolvedUsername, username);
    assert.equal(status.resolvedUsername, username);
    assert.equal(status.hasState, true);
    assert.equal(status.lastSync.downloaded, 2);
    assert.equal(status.lastSync.existing, 3);
    assert.equal(status.lastSyncedLogId, logId);
    assert.deepEqual(calls, []);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle counts canonical logs without requiring sync state', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-status-local-'));
  const logId = '07L000000000024AAA';
  const localPath = path.join(
    workspaceRoot,
    'apexlogs',
    'orgs',
    'local-only@example.com',
    'logs',
    '2026-07-20',
    `${logId}.log`
  );
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'local only', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    const status = await lifecycle.status({ workspaceRoot });
    assert.equal(status.localLogCount, 1);
    assert.equal(status.hasState, false);
    assert.equal(status.hasCheckpoint, false);
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle reports corrupt local state through a stable persistence error', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-lifecycle-corrupt-state-'));
  const statePath = path.join(workspaceRoot, 'apexlogs', '.alv', 'sync-state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, '{not-json', 'utf8');
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    await assert.rejects(
      lifecycle.status({ workspaceRoot }),
      error =>
        error instanceof ApexLogLifecycleError &&
        error.code === 'local-persistence' &&
        error.context.operation === 'status'
    );
  } finally {
    lifecycle.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Apex Log Lifecycle translates local directory scan failures into a stable error', async () => {
  const workspaceRoot = path.join(os.tmpdir(), `invalid${String.fromCharCode(0)}path`);
  const logId = '07L000000000033AAA';
  const lifecycle = createApexLogLifecycle({ remote: unavailableRemote([]) });

  try {
    await assert.rejects(
      lifecycle.requireLocalPath({ workspaceRoot, targetOrg: 'scan@example.com', log: { logId } }),
      error =>
        error instanceof ApexLogLifecycleError &&
        error.code === 'local-persistence' &&
        error.context.operation === 'require-local-path'
    );
  } finally {
    lifecycle.dispose();
  }
});
