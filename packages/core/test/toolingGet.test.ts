import assert from 'node:assert/strict';
import test from 'node:test';

import { createApexLogViewerCore } from '../src/index.ts';
import {
  isolateSalesforceHome,
  saveOrgAuth,
  salesforceError,
  startSalesforceDouble,
  type DoubleHandler
} from './support/salesforceDouble.ts';

isolateSalesforceHome();

const logId = '07L000000000001AAA';
const apexLog = { attributes: { type: 'ApexLog' }, Id: logId, LogLength: 2048 };

const toolingApi: DoubleHandler = request => {
  if (request.path === `/tooling/sobjects/ApexLog/${logId}`) return { body: apexLog };
  if (request.path === '/tooling/query') return { body: { totalSize: 1, done: true, records: [apexLog] } };
  return salesforceError('NOT_FOUND', `The requested resource does not exist: ${request.path}`, 404);
};

async function toolingGet(t: test.TestContext, username: string, path: (instanceUrl: string) => string) {
  const salesforce = await startSalesforceDouble(t, toolingApi);
  await saveOrgAuth(username, salesforce.instanceUrl);
  const core = createApexLogViewerCore();
  t.after(() => core.dispose());
  const result = core.tooling.get({ targetOrg: username, path: path(salesforce.instanceUrl) });
  return { salesforce, result };
}

const recordPaths: Array<[string, (instanceUrl: string) => string]> = [
  ['a path relative to the Tooling API', () => `sobjects/ApexLog/${logId}`],
  ['a path under /tooling', () => `/tooling/sobjects/ApexLog/${logId}`],
  ['a /services/data path', () => `/services/data/v63.0/tooling/sobjects/ApexLog/${logId}`],
  [
    'an absolute URL on the org instance',
    instanceUrl => `${instanceUrl}/services/data/v63.0/tooling/sobjects/ApexLog/${logId}`
  ]
];

recordPaths.forEach(([form, path], index) => {
  test(`tooling.get reads the Tooling API record named by ${form}`, async t => {
    const { salesforce, result } = await toolingGet(t, `tooling-get-${index}@example.com`, path);

    assert.deepEqual(await result, apexLog);
    assert.deepEqual(
      salesforce.requests.map(request => `${request.method} ${request.path}`),
      [`GET /tooling/sobjects/ApexLog/${logId}`]
    );
  });
});

test('tooling.get keeps the query string of a relative Tooling API path', async t => {
  const { salesforce, result } = await toolingGet(
    t,
    'tooling-get-query@example.com',
    () => 'query?q=SELECT+Id,LogLength+FROM+ApexLog'
  );

  assert.deepEqual(await result, { totalSize: 1, done: true, records: [apexLog] });
  assert.deepEqual(
    salesforce.requests.map(request => [request.path, request.query.get('q')]),
    [['/tooling/query', 'SELECT Id,LogLength FROM ApexLog']]
  );
});

test('tooling.get refuses an absolute URL outside the org instance before it sends anything', async t => {
  const { salesforce, result } = await toolingGet(
    t,
    'tooling-get-foreign@example.com',
    () => `https://elsewhere.example.com/services/data/v63.0/tooling/sobjects/ApexLog/${logId}`
  );

  await assert.rejects(result, /must target the authenticated org instance/);
  assert.equal(salesforce.requests.length, 0);
});
