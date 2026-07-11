import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';

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
