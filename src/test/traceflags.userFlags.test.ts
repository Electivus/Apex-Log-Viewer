import assert from 'assert/strict';
import { EventEmitter } from 'events';
import type { OrgAuth } from '../salesforce/types';
import { __resetHttpsRequestImplForTests, __setHttpsRequestImplForTests } from '../salesforce/http';
import {
  getUserTraceFlagStatus,
  listActiveUsers,
  removeUserTraceFlags,
  upsertUserTraceFlag
} from '../salesforce/traceflags';

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

suite('traceflags user management', () => {
  const auth: OrgAuth = {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    username: 'user@example.com'
  };

  teardown(() => {
    __resetHttpsRequestImplForTests();
  });

  test('listActiveUsers returns active users filtered by query', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'Ada Lovelace', Username: 'ada@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'Grace Hopper', Username: 'grace@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const users = await listActiveUsers(auth, 'ada', 25);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.id, '005000000000001AAA');
    assert.equal(users[0]?.username, 'ada@example.com');
    assert.equal(users[0]?.active, true);

    const soql = decodeSoql(calls[0]?.path || '');
    assert.match(soql, /FROM User/);
    assert.match(soql, /IsActive = true/);
    assert.match(soql, /Name LIKE '%ada%'/i);
    assert.doesNotMatch(soql, /\bESCAPE\b/i);
  });

  test('listActiveUsers applies local filtering when API returns broader result set', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'Ada Lovelace', Username: 'ada@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'Grace Hopper', Username: 'grace@example.com', IsActive: true },
              { Id: '005000000000003AAA', Name: 'Manoel Silva', Username: 'manoel@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const users = await listActiveUsers(auth, 'manoel', 50);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.id, '005000000000003AAA');
    assert.equal(users[0]?.username, 'manoel@example.com');
  });

  test('listActiveUsers local filtering is locale-stable for dotted-i scenarios', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'ILKER', Username: 'lk@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'GRACE', Username: 'grace@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    (String.prototype as any).toLocaleLowerCase = function (locales?: string | string[]): string {
      if (locales !== undefined) {
        return originalToLocaleLowerCase.call(this, locales);
      }
      // Simulate a locale where 'I' lowercases to a non-ASCII dotted variant.
      return String(this).replace(/I/g, 'ı').toLowerCase();
    };

    try {
      const users = await listActiveUsers(auth, 'i', 50);
      assert.equal(users.length, 1);
      assert.equal(users[0]?.id, '005000000000001AAA');
      assert.equal(users[0]?.username, 'lk@example.com');
    } finally {
      (String.prototype as any).toLocaleLowerCase = originalToLocaleLowerCase;
    }
  });

  test('getUserTraceFlagStatus parses active status and metadata', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            records: [
              {
                Id: '7tf000000000001AAA',
                StartDate: '2026-02-19T16:00:00.000Z',
                ExpirationDate: '2099-02-19T18:00:00.000Z',
                DebugLevel: { DeveloperName: 'ALV_E2E' }
              }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getUserTraceFlagStatus(auth, '005000000000001AAA');
    assert.ok(status);
    assert.equal(status?.traceFlagId, '7tf000000000001AAA');
    assert.equal(status?.debugLevelName, 'ALV_E2E');
    assert.equal(status?.isActive, true);
  });

  test('upsertUserTraceFlag updates existing USER_DEBUG flag', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes('FROM TraceFlag')) {
          return { statusCode: 200, body: { records: [{ Id: '7tf000000000001AAA' }] } };
        }
      }
      if (req.method === 'PATCH' && req.path.includes('/tooling/sobjects/TraceFlag/7tf000000000001AAA')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        assert.ok(typeof parsed.StartDate === 'string');
        assert.ok(typeof parsed.ExpirationDate === 'string');
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertUserTraceFlag(auth, {
      userId: '005000000000001AAA',
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 45
    });
    assert.equal(result.created, false);
    assert.equal(result.traceFlagId, '7tf000000000001AAA');
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  });

  test('upsertUserTraceFlag creates USER_DEBUG flag when none exists', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes('FROM TraceFlag')) {
          return { statusCode: 200, body: { records: [] } };
        }
      }
      if (req.method === 'POST' && req.path.endsWith('/tooling/sobjects/TraceFlag')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.TracedEntityId, '005000000000001AAA');
        assert.equal(parsed.LogType, 'USER_DEBUG');
        return { statusCode: 201, body: { success: true, id: '7tf000000000999AAA' } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertUserTraceFlag(auth, {
      userId: '005000000000001AAA',
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 30
    });
    assert.equal(result.created, true);
    assert.equal(result.traceFlagId, '7tf000000000999AAA');
  });

  test('removeUserTraceFlags deletes all USER_DEBUG flags for user', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: { records: [{ Id: '7tf000000000001AAA' }, { Id: '7tf000000000002AAA' }] }
        };
      }
      if (req.method === 'DELETE' && req.path.includes('/tooling/sobjects/TraceFlag/')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const removed = await removeUserTraceFlags(auth, '005000000000001AAA');
    assert.equal(removed, 2);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
  });
});
