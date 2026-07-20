import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, ApexLogLifecycleError, createApexLogViewerCore, parseApexLogIds } from '../src/index.ts';
import type { ApexLogRemote } from '../src/logLifecycle.ts';
import { awaitWithAbort, deleteApexLogIds, runLimited } from '../src/runtime.ts';

function unavailableApexLogRemote(): ApexLogRemote {
  return {
    async resolveOrg() {
      throw new Error('Salesforce is unavailable');
    },
    async listLogs() {
      throw new Error('Salesforce is unavailable');
    },
    async readBody() {
      throw new Error('Salesforce is unavailable');
    }
  };
}

test('core log resolve finds legacy cached paths without Salesforce auth', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-legacy-'));
  const logId = '07L000000000001AAA';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `demo@example.com_${logId}.log`);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'legacy body');

  const core = createApexLogViewerCore();
  const result = await core.log.resolve({ logId, targetOrg: 'demo@example.com', workspaceRoot });

  assert.equal(result.path, legacyPath);
  assert.equal(result.cached, true);
});

test('core triages locally cached logs without requiring the CLI plugin', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-triage-'));
  const logId = '07L000000000002AAA';
  const logPath = path.join(workspaceRoot, 'apexlogs', `demo@example.com_${logId}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, '12:00:00.0|FATAL_ERROR|System.NullPointerException: boom');

  const core = createApexLogViewerCore({ apexLogRemote: unavailableApexLogRemote() });
  const result = await core.log.triage({ logIds: [logId], username: 'demo@example.com', workspaceRoot });

  assert.equal(result[0]?.summary.hasErrors, true);
  assert.equal(result[0]?.summary.primaryReason, 'Fatal exception');
  core.dispose();
});

test('core reports cancellation through its stable error and instrumentation contract', async () => {
  const events: Array<{ method: string; outcome: string }> = [];
  const controller = new AbortController();
  controller.abort();
  const core = createApexLogViewerCore({
    apexLogRemote: unavailableApexLogRemote(),
    instrumentation: { onCall: event => events.push({ method: event.method, outcome: event.outcome }) }
  });

  await assert.rejects(
    core.log.list({}, { signal: controller.signal }),
    error => error instanceof AlvError && error.code === 'ABORTED'
  );
  assert.deepEqual(events, [{ method: 'log.list', outcome: 'cancelled' }]);
});

test('core instruments the public Apex Log Lifecycle seam', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-lifecycle-instrumentation-'));
  const username = 'instrumented@example.com';
  const logId = '07L000000000009AAA';
  const localPath = path.join(workspaceRoot, 'apexlogs', `${username}_${logId}.log`);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'instrumented body', 'utf8');
  const events: Array<{ method: string; outcome: string }> = [];
  const core = createApexLogViewerCore({
    apexLogRemote: unavailableApexLogRemote(),
    instrumentation: { onCall: event => events.push({ method: event.method, outcome: event.outcome }) }
  });

  try {
    const result = await core.logLifecycle.requireLocalPath({
      workspaceRoot,
      targetOrg: username,
      log: { logId }
    });

    assert.equal(result.localPath, localPath);
    assert.deepEqual(events, [{ method: 'log.lifecycle.requireLocalPath', outcome: 'ok' }]);
  } finally {
    core.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('core lifecycle instrumentation preserves its stable cancellation error', async () => {
  const events: Array<{ method: string; outcome: string }> = [];
  const controller = new AbortController();
  controller.abort();
  const core = createApexLogViewerCore({
    instrumentation: { onCall: event => events.push({ method: event.method, outcome: event.outcome }) }
  });

  try {
    await assert.rejects(
      core.logLifecycle.status({ workspaceRoot: os.tmpdir() }, { signal: controller.signal }),
      error => error instanceof ApexLogLifecycleError && error.code === 'cancelled'
    );
    assert.deepEqual(events, [{ method: 'log.lifecycle.status', outcome: 'cancelled' }]);
  } finally {
    core.dispose();
  }
});

test('core only parses Salesforce ApexLog ids', () => {
  assert.deepEqual(
    parseApexLogIds('07L000000000001, 001000000000001, invalid, 07L000000000001AAA, 07L000000000001AAA'),
    ['07L000000000001', '07L000000000001AAA']
  );
});

test('core aborts an in-flight stream-backed request', async () => {
  const controller = new AbortController();
  let resolvePending!: (value: string) => void;
  let destroyed = 0;
  const pending = Object.assign(
    new Promise<string>(resolve => {
      resolvePending = resolve;
    }),
    {
      stream: () => ({
        destroy: () => {
          destroyed += 1;
        }
      })
    }
  );

  const result = awaitWithAbort(pending, controller.signal);
  controller.abort();

  await assert.rejects(result, error => error instanceof AlvError && error.code === 'ABORTED');
  assert.equal(destroyed, 1);
  resolvePending('late result');
});

test('core stops scheduling bounded work after cancellation', async () => {
  const controller = new AbortController();
  const processed: number[] = [];
  let notifyStarted!: () => void;
  let releaseWorker!: () => void;
  const started = new Promise<void>(resolve => {
    notifyStarted = resolve;
  });
  const workerGate = new Promise<void>(resolve => {
    releaseWorker = resolve;
  });
  const work = runLimited(
    [1, 2, 3],
    1,
    async item => {
      processed.push(item);
      notifyStarted();
      await workerGate;
    },
    controller.signal
  );

  await started;
  controller.abort();
  releaseWorker();

  await assert.rejects(work, error => error instanceof AlvError && error.code === 'ABORTED');
  assert.deepEqual(processed, [1]);
});

test('core stops scheduling ApexLog deletion chunks after cancellation', async () => {
  const controller = new AbortController();
  const logIds = Array.from({ length: 401 }, (_, index) => `07L${String(index).padStart(15, '0')}`);
  let requestCount = 0;
  let destroyed = 0;
  let notifyStarted!: () => void;
  let releaseRequest!: (value: unknown[]) => void;
  const started = new Promise<void>(resolve => {
    notifyStarted = resolve;
  });
  const connection = {
    getApiVersion: () => '63.0',
    request: () => {
      requestCount += 1;
      notifyStarted();
      return Object.assign(
        new Promise<unknown[]>(resolve => {
          releaseRequest = resolve;
        }),
        {
          stream: () => ({
            destroy: () => {
              destroyed += 1;
            }
          })
        }
      );
    }
  };

  const deletion = deleteApexLogIds({ connection } as never, logIds, 1, controller.signal);
  await started;
  controller.abort();

  await assert.rejects(deletion, error => error instanceof AlvError && error.code === 'ABORTED');
  assert.equal(requestCount, 1, 'must not start later deletion chunks after cancellation');
  assert.equal(destroyed, 1, 'must abort the in-flight Salesforce request');
  releaseRequest([]);
});

test('core log read uses the shared Apex Log Lifecycle seam', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-lifecycle-read-'));
  const logId = '07L000000000017AAA';
  const username = 'core@example.com';
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      throw new Error('listLogs is not used by log read');
    },
    async readBody() {
      return 'core lifecycle body';
    }
  };
  const core = createApexLogViewerCore({ apexLogRemote: remote });

  try {
    const result = await core.log.read({ logId, targetOrg: username, workspaceRoot });
    assert.equal(result.body, 'core lifecycle body');
    assert.equal(result.path.endsWith(`${logId}.log`), true);
  } finally {
    core.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('core log sync preserves its public result while using the shared lifecycle', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-lifecycle-sync-'));
  const logId = '07L000000000018AAA';
  const username = 'sync-core@example.com';
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return [{ logId, startTime: '2026-07-20T13:00:00.000Z' }];
    },
    async readBody() {
      return 'sync core body';
    }
  };
  const core = createApexLogViewerCore({ apexLogRemote: remote });

  try {
    const result = await core.log.sync({ targetOrg: username, workspaceRoot });
    assert.equal(result.status, 'success');
    assert.equal(result.targetOrg, username);
    assert.equal(result.downloaded, 1);
    assert.equal(result.cached, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.checkpointAdvanced, true);
    assert.equal(result.lastSyncedLogId, logId);
  } finally {
    core.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('core log status maps lifecycle state to the compatibility DTO', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-lifecycle-status-'));
  const logId = '07L000000000019AAA';
  const username = 'status-core@example.com';
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      return [{ logId, startTime: '2026-07-20T13:30:00.000Z' }];
    },
    async readBody() {
      return 'status core body';
    }
  };
  const core = createApexLogViewerCore({ apexLogRemote: remote });

  try {
    await core.log.sync({ targetOrg: username, workspaceRoot });
    const result = await core.log.status({ targetOrg: username, workspaceRoot });
    assert.equal(result.targetOrg, username);
    assert.equal(result.logCount, 1);
    assert.equal(result.hasState, true);
    assert.equal(result.downloadedCount, 1);
    assert.equal(result.cachedCount, 0);
    assert.equal(result.lastSyncedLogId, logId);
  } finally {
    core.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('core log triage preserves its DTO while using lifecycle acquisition', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-lifecycle-triage-'));
  const logId = '07L000000000020AAA';
  const username = 'triage-core@example.com';
  const remote: ApexLogRemote = {
    async resolveOrg() {
      return { username };
    },
    async listLogs() {
      throw new Error('listLogs is not used by triage');
    },
    async readBody() {
      return '12:00:00.0|FATAL_ERROR|System.NullPointerException: lifecycle';
    }
  };
  const core = createApexLogViewerCore({ apexLogRemote: remote });

  try {
    const result = await core.log.triage({ username, logIds: [logId], workspaceRoot });
    assert.equal(result[0]?.logId, logId);
    assert.equal(result[0]?.summary.hasErrors, true);
    assert.equal(result[0]?.summary.primaryReason, 'Fatal exception');
  } finally {
    core.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
