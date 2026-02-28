import assert from 'assert/strict';
import { EventEmitter } from 'events';
import type { OrgAuth } from '../salesforce/types';
import { __resetHttpsRequestImplForTests, __setHttpsRequestImplForTests } from '../salesforce/http';
import { deleteApexLogs, fetchAllApexLogIds } from '../salesforce/apexLogs';

type StubRequest = {
  method: string;
  path: string;
  body: string;
};

function installHttpsStub(
  responder: (req: StubRequest) => { statusCode: number; body?: unknown }
): StubRequest[] {
  const calls: StubRequest[] = [];
  __setHttpsRequestImplForTests((options: any, cb: any) => {
    const req = new EventEmitter() as any;
    let body = '';
    req.on = function (event: string, listener: any) {
      EventEmitter.prototype.on.call(this, event, listener);
      return this;
    };
    req.setHeader = () => {};
    req.write = (chunk: any) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    };
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const snapshot: StubRequest = {
        method: String(options?.method || 'GET'),
        path: String(options?.path || ''),
        body
      };
      calls.push(snapshot);
      let output: { statusCode: number; body?: unknown };
      try {
        output = responder(snapshot);
      } catch (e) {
        process.nextTick(() => req.emit('error', e));
        return;
      }
      const res = new EventEmitter() as any;
      res.statusCode = output.statusCode;
      res.headers = {};
      res.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      res.setEncoding = () => {};
      res.req = req;
      cb(res);
      process.nextTick(() => {
        const text =
          output.body === undefined ? '' : typeof output.body === 'string' ? output.body : JSON.stringify(output.body);
        if (text) {
          res.emit('data', Buffer.from(text));
        }
        res.emit('end');
      });
    };
    return req;
  });
  return calls;
}

function decodeSoql(path: string): string {
  const qMarker = '?q=';
  const idx = path.indexOf(qMarker);
  if (idx < 0) {
    return '';
  }
  return decodeURIComponent(path.slice(idx + qMarker.length));
}

suite('apex logs deletion', () => {
  const auth: OrgAuth = {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    username: 'user@example.com'
  };

  teardown(() => {
    __resetHttpsRequestImplForTests();
  });

  test('fetchAllApexLogIds uses nextRecordsUrl pagination', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        if (req.path.includes('/tooling/query/')) {
          return {
            statusCode: 200,
            body: {
              done: true,
              records: [{ Id: 'id0' }]
            }
          };
        }
        const soql = decodeSoql(req.path);
        assert.match(soql, /FROM ApexLog/);
        assert.match(soql, /ORDER BY StartTime DESC, Id DESC/);
        assert.match(soql, /LIMIT 2/);
        return {
          statusCode: 200,
          body: {
            done: false,
            nextRecordsUrl: '/services/data/v64.0/tooling/query/01g000000000001AAA-2000',
            records: [{ Id: 'id2' }, { Id: 'id1' }]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const ids = await fetchAllApexLogIds(auth, { limit: 2 });
    assert.deepEqual(ids, ['id2', 'id1', 'id0']);

    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.path, '/services/data/v64.0/tooling/query/01g000000000001AAA-2000');
  });

  test('fetchAllApexLogIds includes LogUserId filter when userId is provided', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        assert.match(soql, /FROM ApexLog/);
        assert.match(soql, /LogUserId = '005000000000001AAA'/);
        return { statusCode: 200, body: { done: true, records: [] } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const ids = await fetchAllApexLogIds(auth, { limit: 2, userId: '005000000000001AAA' });
    assert.deepEqual(ids, []);
    assert.equal(calls.length, 1);
  });

  test('fetchAllApexLogIds does not add an implicit LIMIT when limit is not provided', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        assert.match(soql, /FROM ApexLog/);
        assert.doesNotMatch(soql, /\bLIMIT\b/i);
        return { statusCode: 200, body: { done: true, records: [] } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const ids = await fetchAllApexLogIds(auth);
    assert.deepEqual(ids, []);
    assert.equal(calls.length, 1);
  });

  test('deleteApexLogs returns summary with failed ids', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'DELETE' && req.path.includes('/composite/sobjects')) {
        assert.match(req.path, /ids=id1,id2,id3/);
        assert.match(req.path, /allOrNone=false/);
        return {
          statusCode: 200,
          body: [
            { id: 'id1', success: true },
            { id: 'id2', success: false, errors: [{ message: 'fail', statusCode: 'ERROR' }] },
            { id: 'id3', success: true }
          ]
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const summary = await deleteApexLogs(auth, ['id1', 'id2', 'id3'], { concurrency: 2 });
    assert.equal(summary.total, 3);
    assert.equal(summary.deleted, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 0);
    assert.deepEqual(summary.failedLogIds, ['id2']);

    assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  });
});
