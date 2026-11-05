import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError, createApexLogViewerCore, type TraceFlagLogType } from '../src/index.ts';
import {
  isolateSalesforceHome,
  saveOrgAuth,
  salesforceError,
  startSalesforceDouble,
  type DoubleRequest
} from './support/salesforceDouble.ts';

isolateSalesforceHome();

const USER_ID = '005000000000001AAA';
const target = { type: 'user', userId: USER_ID } as const;
const ACTIVE_UNTIL = '2099-01-01T00:00:00.000+0000';

type ExistingFlag = string | { id: string; expirationDate: string };

/** An org with one debug level and, per log type, the trace flag already on the user (active unless its expiration says otherwise). */
async function traceFlagOrg(
  t: test.TestContext,
  username: string,
  existing: Partial<Record<TraceFlagLogType, ExistingFlag>>
) {
  const salesforce = await startSalesforceDouble(t, request => {
    const soql = request.query.get('q') ?? '';
    if (request.method === 'GET' && request.path === '/tooling/query' && soql.includes('FROM DebugLevel')) {
      return { body: { totalSize: 1, done: true, records: [{ Id: '7dl000000000001AAA' }] } };
    }
    if (request.method === 'GET' && request.path === '/tooling/query' && soql.includes('FROM TraceFlag')) {
      const records = Object.entries(existing)
        .filter(([logType]) => soql.includes(`'${logType}'`))
        .map(([logType, flag]) => {
          const { id, expirationDate } = typeof flag === 'string' ? { id: flag, expirationDate: ACTIVE_UNTIL } : flag!;
          return {
            Id: id,
            TracedEntityId: USER_ID,
            LogType: logType,
            StartDate: '2026-01-01T00:00:00.000+0000',
            ExpirationDate: expirationDate,
            DebugLevel: { DeveloperName: 'ALV_DEBUG' }
          };
        });
      return { body: { totalSize: records.length, done: true, records } };
    }
    if (request.method === 'POST' && request.path === '/tooling/sobjects/TraceFlag') {
      return { status: 201, body: { id: '7tf000000000009AAA', success: true, errors: [] } };
    }
    if (
      (request.method === 'PATCH' || request.method === 'DELETE') &&
      request.path.startsWith('/tooling/sobjects/TraceFlag/')
    ) {
      return { status: 204, body: undefined };
    }
    return salesforceError('NOT_FOUND', `${request.method} ${request.path}`, 404);
  });
  await saveOrgAuth(username, salesforce.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  return { core, salesforce };
}

const traceFlagQueries = (requests: DoubleRequest[]) =>
  requests
    .filter(request => (request.query.get('q') ?? '').includes('FROM TraceFlag'))
    .map(request => request.query.get('q'));

const traceFlagWrites = (requests: DoubleRequest[]) =>
  requests
    .filter(request => request.method !== 'GET' && request.path.startsWith('/tooling/sobjects/TraceFlag'))
    .map(request => ({
      method: request.method,
      path: request.path,
      body: request.body ? JSON.parse(request.body) : undefined
    }));

test('trace flag status reads DEVELOPER_LOG flags unless USER_DEBUG is requested', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'status@example.com', {
    DEVELOPER_LOG: '7tf000000000001AAA',
    USER_DEBUG: '7tf000000000002AAA'
  });

  const developer = await core.traceFlag.status({ targetOrg: 'status@example.com', target });
  const userDebug = await core.traceFlag.status({ targetOrg: 'status@example.com', target, logType: 'USER_DEBUG' });

  assert.deepEqual(
    [developer.logType, developer.traceFlagId, userDebug.logType, userDebug.traceFlagId],
    ['DEVELOPER_LOG', '7tf000000000001AAA', 'USER_DEBUG', '7tf000000000002AAA']
  );
  assert.deepEqual(
    traceFlagQueries(salesforce.requests).map(soql => soql?.match(/LogType IN \(([^)]*)\)/)?.[1]),
    ["'DEVELOPER_LOG','USER_DEBUG'", "'DEVELOPER_LOG','USER_DEBUG'"],
    'each status reads both log types in one query'
  );
});

test('a USER_DEBUG status reports the DEVELOPER_LOG flag whose debug level overrides it', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'status-overridden@example.com', {
    DEVELOPER_LOG: { id: '7tf000000000001AAA', expirationDate: '2098-06-01T12:00:00.000+0000' },
    USER_DEBUG: '7tf000000000002AAA'
  });

  const status = await core.traceFlag.status({
    targetOrg: 'status-overridden@example.com',
    target,
    logType: 'USER_DEBUG'
  });

  assert.deepEqual(
    [status.isActive, status.traceFlagId, status.expirationDate],
    [true, '7tf000000000002AAA', ACTIVE_UNTIL]
  );
  assert.deepEqual(status.otherLogType, {
    logType: 'DEVELOPER_LOG',
    isActive: true,
    activeTargetCount: 1,
    expirationDate: '2098-06-01T12:00:00.000+0000'
  });
  assert.equal(traceFlagQueries(salesforce.requests).length, 1);
});

test('a DEVELOPER_LOG status with no flag of its own reports the active USER_DEBUG flag', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'status-hidden@example.com', {
    USER_DEBUG: '7tf000000000002AAA'
  });

  const status = await core.traceFlag.status({ targetOrg: 'status-hidden@example.com', target });

  assert.deepEqual([status.logType, status.isActive, status.traceFlagId], ['DEVELOPER_LOG', false, undefined]);
  assert.deepEqual(status.otherLogType, {
    logType: 'USER_DEBUG',
    isActive: true,
    activeTargetCount: 1,
    expirationDate: ACTIVE_UNTIL
  });
  assert.equal(traceFlagQueries(salesforce.requests).length, 1);
});

test('an expired flag of the other log type counts as inactive', async t => {
  const { core } = await traceFlagOrg(t, 'status-expired@example.com', {
    DEVELOPER_LOG: '7tf000000000001AAA',
    USER_DEBUG: { id: '7tf000000000002AAA', expirationDate: '2017-01-01T00:00:00.000+0000' }
  });

  const status = await core.traceFlag.status({ targetOrg: 'status-expired@example.com', target });

  assert.equal(status.isActive, true);
  assert.deepEqual(status.otherLogType, { logType: 'USER_DEBUG', isActive: false, activeTargetCount: 0 });
});

test('an unavailable target reports no other log type', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'status-unavailable@example.com', {
    USER_DEBUG: '7tf000000000002AAA'
  });

  const status = await core.traceFlag.status({
    targetOrg: 'status-unavailable@example.com',
    target: { type: 'user', userId: 'not-a-salesforce-id' }
  });

  assert.equal(status.targetAvailable, false);
  assert.equal('otherLogType' in status, false);
  assert.deepEqual(traceFlagQueries(salesforce.requests), []);
});

test('trace flag apply creates a DEVELOPER_LOG flag by default and a USER_DEBUG flag on request', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'apply-create@example.com', {});

  const developer = await core.traceFlag.apply({
    targetOrg: 'apply-create@example.com',
    target,
    debugLevelName: 'ALV_DEBUG',
    confirmed: true
  });
  const userDebug = await core.traceFlag.apply({
    targetOrg: 'apply-create@example.com',
    target,
    debugLevelName: 'ALV_DEBUG',
    logType: 'USER_DEBUG',
    confirmed: true
  });

  assert.deepEqual([developer.logType, userDebug.logType], ['DEVELOPER_LOG', 'USER_DEBUG']);
  assert.deepEqual(
    traceFlagWrites(salesforce.requests).map(write => [write.method, write.body?.TracedEntityId, write.body?.LogType]),
    [
      ['POST', USER_ID, 'DEVELOPER_LOG'],
      ['POST', USER_ID, 'USER_DEBUG']
    ]
  );
});

test('trace flag apply updates the flag of the requested type without rewriting its create-only LogType', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'apply-update@example.com', {
    DEVELOPER_LOG: '7tf000000000001AAA',
    USER_DEBUG: '7tf000000000002AAA'
  });

  const result = await core.traceFlag.apply({
    targetOrg: 'apply-update@example.com',
    target,
    debugLevelName: 'ALV_DEBUG',
    logType: 'USER_DEBUG',
    confirmed: true
  });

  assert.deepEqual(
    [result.logType, result.updatedCount, result.traceFlagIds],
    ['USER_DEBUG', 1, ['7tf000000000002AAA']]
  );
  const writes = traceFlagWrites(salesforce.requests);
  assert.deepEqual(
    writes.map(write => [write.method, write.path]),
    [['PATCH', '/tooling/sobjects/TraceFlag/7tf000000000002AAA']]
  );
  assert.equal('LogType' in writes[0]!.body, false);
});

test('trace flag remove deletes only the flags of the requested type', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'remove@example.com', {
    DEVELOPER_LOG: '7tf000000000001AAA',
    USER_DEBUG: '7tf000000000002AAA'
  });

  const developer = await core.traceFlag.remove({ targetOrg: 'remove@example.com', target, confirmed: true });
  const userDebug = await core.traceFlag.remove({
    targetOrg: 'remove@example.com',
    target,
    logType: 'USER_DEBUG',
    confirmed: true
  });

  assert.deepEqual([developer.logType, userDebug.logType], ['DEVELOPER_LOG', 'USER_DEBUG']);
  assert.deepEqual(
    traceFlagWrites(salesforce.requests).map(write => [write.method, write.path]),
    [
      ['DELETE', '/tooling/sobjects/TraceFlag/7tf000000000001AAA'],
      ['DELETE', '/tooling/sobjects/TraceFlag/7tf000000000002AAA']
    ]
  );
});

test('trace flag calls reject a log type Salesforce does not define before reading any trace flag', async t => {
  const { core, salesforce } = await traceFlagOrg(t, 'invalid@example.com', {});
  const logType = "USER_DEBUG' OR LogType != '" as TraceFlagLogType;

  const calls = [
    core.traceFlag.status({ targetOrg: 'invalid@example.com', target, logType }),
    core.traceFlag.apply({
      targetOrg: 'invalid@example.com',
      target,
      logType,
      debugLevelName: 'ALV_DEBUG',
      confirmed: true
    }),
    core.traceFlag.remove({ targetOrg: 'invalid@example.com', target, logType, confirmed: true })
  ];

  for (const call of calls) {
    await assert.rejects(call, (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT');
  }
  assert.deepEqual(traceFlagQueries(salesforce.requests), []);
  assert.deepEqual(traceFlagWrites(salesforce.requests), []);
});
