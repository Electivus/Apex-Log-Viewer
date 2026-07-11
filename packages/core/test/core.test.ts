import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore, parseApexLogIds } from '../src/index.ts';
import { awaitWithAbort, deleteApexLogIds, runLimited } from '../src/runtime.ts';

test('core resolves legacy cached log paths without Salesforce auth', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-legacy-'));
  const logId = '07L000000000001AAA';
  const legacyPath = path.join(workspaceRoot, 'apexlogs', `demo@example.com_${logId}.log`);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, 'legacy body');

  const core = createApexLogViewerCore();
  const result = await core.log.resolveCachedPath({ logId, username: 'demo@example.com', workspaceRoot });

  assert.equal(result.path, legacyPath);
});

test('core triages locally cached logs without requiring the CLI plugin', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-core-triage-'));
  const logId = '07L000000000002AAA';
  const logPath = path.join(workspaceRoot, 'apexlogs', `demo@example.com_${logId}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, '12:00:00.0|FATAL_ERROR|System.NullPointerException: boom');

  const result = await createApexLogViewerCore().log.triage({
    logIds: [logId],
    username: 'demo@example.com',
    workspaceRoot
  });

  assert.equal(result[0]?.summary.hasErrors, true);
  assert.equal(result[0]?.summary.primaryReason, 'Fatal exception');
});

test('core reports cancellation through its stable error and instrumentation contract', async () => {
  const events: Array<{ method: string; outcome: string }> = [];
  const controller = new AbortController();
  controller.abort();
  const core = createApexLogViewerCore({
    instrumentation: { onCall: event => events.push({ method: event.method, outcome: event.outcome }) }
  });

  await assert.rejects(
    core.log.list({}, { signal: controller.signal }),
    error => error instanceof AlvError && error.code === 'ABORTED'
  );
  assert.deepEqual(events, [{ method: 'log.list', outcome: 'cancelled' }]);
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
