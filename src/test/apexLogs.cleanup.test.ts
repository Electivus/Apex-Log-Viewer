import assert from 'assert/strict';
import { EventEmitter } from 'events';
import type { OrgAuth } from '../salesforce/types';
import { __resetHttpsRequestImplForTests, __setHttpsRequestImplForTests } from '../salesforce/http';
import { __resetUserIdCacheForTests } from '../salesforce/traceflags';
import { clearApexLogs } from '../services/apexLogCleanup';

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

suite('apex logs cleanup', () => {
  const auth: OrgAuth = {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    username: 'user@example.com'
  };

  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetUserIdCacheForTests();
  });

  test('clearApexLogs(scope=all) lists ids and deletes them', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            done: true,
            records: [
              { Id: 'id2', StartTime: '2026-02-28T10:00:00.000Z' },
              { Id: 'id1', StartTime: '2026-02-28T09:00:00.000Z' }
            ]
          }
        };
      }
      if (req.method === 'DELETE' && req.path.includes('/composite/sobjects')) {
        assert.match(req.path, /ids=id2,id1/);
        assert.match(req.path, /allOrNone=false/);
        return {
          statusCode: 200,
          body: [
            { id: 'id2', success: true },
            { id: 'id1', success: true }
          ]
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await clearApexLogs(auth, 'all', { concurrency: 2 });
    assert.equal(result.scope, 'all');
    assert.equal(result.listed, 2);
    assert.equal(result.total, 2);
    assert.equal(result.deleted, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.cancelled, 0);
    assert.deepEqual(result.failedLogIds, []);

    assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  });

  test('clearApexLogs(scope=mine) resolves current user id and applies LogUserId filter', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        assert.match(soql, /FROM ApexLog/);
        assert.match(soql, /LogUserId = '005000000000001AAA'/);
        return {
          statusCode: 200,
          body: { done: true, records: [{ Id: 'id1', StartTime: '2026-02-28T10:00:00.000Z' }] }
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/') && req.path.includes('/query')) {
        return {
          statusCode: 200,
          body: { records: [{ Id: '005000000000001AAA' }] }
        };
      }
      if (req.method === 'DELETE' && req.path.includes('/composite/sobjects')) {
        assert.match(req.path, /ids=id1/);
        assert.match(req.path, /allOrNone=false/);
        return {
          statusCode: 200,
          body: [{ id: 'id1', success: true }]
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await clearApexLogs(auth, 'mine');
    assert.equal(result.scope, 'mine');
    assert.equal(result.userId, '005000000000001AAA');
    assert.equal(result.listed, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedLogIds, []);

    assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  });
});
