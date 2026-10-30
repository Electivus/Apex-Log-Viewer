import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError, createApexLogViewerCore } from '../src/index.ts';
import { queryData } from '../src/dataQuery.ts';
import {
  isolateSalesforceHome,
  openConnection,
  saveOrgAuth,
  startSalesforceDouble,
  salesforceError,
  type DoubleHandler
} from './support/salesforceDouble.ts';

isolateSalesforceHome();

const records = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ Id: `005${String(from + index).padStart(12, '0')}AAA` }));

/** Three batches of two records: 1-2, 3-4, 5-6, linked by `nextRecordsUrl`. */
const batchedUsers: DoubleHandler = request => {
  if (request.path === '/query') {
    return {
      body: {
        totalSize: 6,
        done: false,
        nextRecordsUrl: '/services/data/v63.0/query/01gBATCH-2',
        records: records(1, 2)
      }
    };
  }
  if (request.path === '/query/01gBATCH-2') {
    return {
      body: {
        totalSize: 6,
        done: false,
        nextRecordsUrl: '/services/data/v63.0/query/01gBATCH-4',
        records: records(3, 4)
      }
    };
  }
  if (request.path === '/query/01gBATCH-4') return { body: { totalSize: 6, done: true, records: records(5, 6) } };
  return salesforceError('NOT_FOUND', request.path, 404);
};

async function connect(t: test.TestContext, username: string, handler: DoubleHandler) {
  const salesforce = await startSalesforceDouble(t, handler);
  await saveOrgAuth(username, salesforce.instanceUrl);
  return { salesforce, connection: await openConnection(username) };
}

test('queryData follows queryMore until Salesforce is done', async t => {
  const { salesforce, connection } = await connect(t, 'batches@example.com', batchedUsers);

  const result = await queryData(connection, 'SELECT Id FROM User', { maxRecords: 100 });

  assert.deepEqual(
    result.records.map(record => record.Id),
    records(1, 6).map(record => record.Id)
  );
  assert.equal(result.totalSize, 6);
  assert.equal(result.done, true);
  assert.deepEqual(
    salesforce.requests.map(request => request.path),
    ['/query', '/query/01gBATCH-2', '/query/01gBATCH-4']
  );
});

test('queryData stops at maxRecords and reports the read as unfinished', async t => {
  const { salesforce, connection } = await connect(t, 'cap@example.com', batchedUsers);

  const result = await queryData(connection, 'SELECT Id FROM User', { maxRecords: 3 });

  assert.equal(result.records.length, 3);
  assert.equal(result.done, false);
  assert.equal(salesforce.requests.length, 2);

  const exact = await queryData(connection, 'SELECT Id FROM User', { maxRecords: 2 });
  assert.equal(exact.records.length, 2);
  assert.equal(exact.done, false);
});

test('queryData stops following batches when the first one already covers maxRecords', async t => {
  const { salesforce, connection } = await connect(t, 'first@example.com', batchedUsers);

  const result = await queryData(connection, 'SELECT Id FROM User LIMIT 1', { maxRecords: 1 });

  assert.equal(result.records.length, 1);
  assert.equal(result.done, false);
  assert.equal(salesforce.requests.length, 1);
});

test('queryData cancels in the middle of queryMore', async t => {
  const controller = new AbortController();
  const handler: DoubleHandler = request => {
    if (request.path === '/query/01gBATCH-2') controller.abort();
    return batchedUsers(request);
  };
  const { salesforce, connection } = await connect(t, 'abort@example.com', handler);

  await assert.rejects(
    queryData(connection, 'SELECT Id FROM User', { maxRecords: 100, signal: controller.signal }),
    (error: unknown) => error instanceof AlvError && error.code === 'ABORTED'
  );
  assert.deepEqual(
    salesforce.requests.map(request => request.path),
    ['/query', '/query/01gBATCH-2']
  );
});

test('queryData does not start when the signal is already aborted', async t => {
  const { salesforce, connection } = await connect(t, 'pre-abort@example.com', batchedUsers);

  await assert.rejects(
    queryData(connection, 'SELECT Id FROM User', { maxRecords: 5, signal: AbortSignal.abort() }),
    (error: unknown) => error instanceof AlvError && error.code === 'ABORTED'
  );
  assert.equal(salesforce.requests.length, 0);
});

test('queryData lets Salesforce errors through unchanged', async t => {
  const { connection } = await connect(t, 'invalid-field@example.com', () =>
    salesforceError('INVALID_FIELD', "No such column 'Nope' on entity 'User'")
  );

  await assert.rejects(
    queryData(connection, 'SELECT Nope FROM User', { maxRecords: 5 }),
    (error: Error & { errorCode?: string }) => error.errorCode === 'INVALID_FIELD'
  );
});

test('user.search returns every user Salesforce splits across batches', async t => {
  const username = 'search@example.com';
  const salesforce = await startSalesforceDouble(t, batchedUsers);
  await saveOrgAuth(username, salesforce.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  const result = await core.user.search({ targetOrg: username, limit: 200 });

  assert.equal(result.users.length, 6);
  assert.equal(salesforce.requests.length, 3);
});

test('user.search rejects a query SOQL cannot spell before it reaches Salesforce', async t => {
  const username = 'control@example.com';
  const salesforce = await startSalesforceDouble(t, batchedUsers);
  await saveOrgAuth(username, salesforce.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());

  await assert.rejects(
    core.user.search({ targetOrg: username, query: 'a\u0007b' }),
    (error: unknown) => error instanceof AlvError && error.code === 'INVALID_ARGUMENT'
  );
  assert.equal(salesforce.requests.length, 0);
});
