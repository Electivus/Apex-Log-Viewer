import assert from 'assert/strict';
import { EventEmitter } from 'events';
import {
  fetchApexLogs,
  clearListCache,
  setApiVersion,
  getApiVersion,
  getEffectiveApiVersion,
  getApiVersionFallbackWarning,
  __setHttpsRequestImplForTests,
  __resetHttpsRequestImplForTests,
  __resetApiVersionFallbackStateForTests
} from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';

suite('fetchApexLogs', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetApiVersionFallbackStateForTests();
    setApiVersion('64.0');
    clearListCache();
  });

  test('performs network request for repeated calls', async () => {
    const auth: OrgAuth = {
      accessToken: 'tok',
      instanceUrl: 'https://example.com',
      username: 'user'
    };

    const body = JSON.stringify({ records: [{ Id: '1' }] });
    let calls = 0;
    __setHttpsRequestImplForTests((options: any, cb: any) => {
      calls++;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        res.setEncoding = () => {};
        res.req = req;
        process.nextTick(() => {
          cb(res);
          process.nextTick(() => {
            res.emit('data', Buffer.from(body));
            res.emit('end');
          });
        });
      };
      return req;
    });

    const first = await fetchApexLogs(auth, 50, 0);
    const second = await fetchApexLogs(auth, 50, 0);
    assert.deepEqual(second, first, 'second call returns matching payload');
    assert.equal(calls, 2, 'network should be called for each request');
  });

  test('respects limit and offset', async () => {
    const auth: OrgAuth = {
      accessToken: 'tok',
      instanceUrl: 'https://example.com',
      username: 'user'
    };

    let capturedPath = '';
    const body = JSON.stringify({ records: [] });
    __setHttpsRequestImplForTests((options: any, cb: any) => {
      capturedPath = options.path;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        res.setEncoding = () => {};
        res.req = req;
        process.nextTick(() => {
          cb(res);
          process.nextTick(() => {
            res.emit('data', Buffer.from(body));
            res.emit('end');
          });
        });
      };
      return req;
    });

    await fetchApexLogs(auth, 3, 7);

    const url = new URL('https://example.com' + capturedPath);
    const q = url.searchParams.get('q') ?? '';
    const decoded = decodeURIComponent(q);
    assert.ok(decoded.includes('LIMIT 3'), 'query should include limit');
    assert.ok(decoded.includes('OFFSET 7'), 'query should include offset');
  });

  test('falls back to org max API version when configured version returns NOT_FOUND', async () => {
    setApiVersion('66.0');
    const auth: OrgAuth = {
      accessToken: 'tok',
      instanceUrl: 'https://example.com',
      username: 'user'
    };

    const hits = new Map<string, number>();
    const inc = (path: string) => hits.set(path, (hits.get(path) || 0) + 1);
    const countByPrefix = (prefix: string) =>
      Array.from(hits.entries())
        .filter(([path]) => path.startsWith(prefix))
        .reduce((acc, [, count]) => acc + count, 0);

    __setHttpsRequestImplForTests((options: any, cb: any) => {
      const path = String(options.path || '');
      inc(path);
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.headers = {};
        res.setEncoding = () => {};
        res.req = req;
        process.nextTick(() => {
          cb(res);
          process.nextTick(() => {
            if (path.startsWith('/services/data/v66.0/tooling/query')) {
              res.statusCode = 404;
              res.emit(
                'data',
                Buffer.from('[{"errorCode":"NOT_FOUND","message":"The requested resource does not exist"}]')
              );
            } else if (path === '/services/data') {
              res.statusCode = 200;
              res.emit(
                'data',
                Buffer.from(JSON.stringify([{ version: '63.0' }, { version: '64.0' }, { version: '62.0' }]))
              );
            } else if (path.startsWith('/services/data/v64.0/tooling/query')) {
              res.statusCode = 200;
              res.emit('data', Buffer.from(JSON.stringify({ records: [{ Id: '07L000000000001AA' }] })));
            } else {
              res.statusCode = 500;
              res.emit('data', Buffer.from(JSON.stringify({ message: `Unexpected path ${path}` })));
            }
            res.emit('end');
          });
        });
      };
      return req;
    });

    const first = await fetchApexLogs(auth, 50, 0);
    const second = await fetchApexLogs(auth, 50, 0);

    assert.equal(first[0]?.Id, '07L000000000001AA');
    assert.equal(second[0]?.Id, '07L000000000001AA');
    assert.equal(getApiVersion(), '66.0', 'configured API version should remain unchanged');
    assert.equal(getEffectiveApiVersion(auth), '64.0', 'effective API version should fallback for this org');
    assert.equal(countByPrefix('/services/data/v66.0/tooling/query'), 1, 'high version should only be attempted once');
    assert.equal(countByPrefix('/services/data/v64.0/tooling/query'), 2, 'fallback version should be reused');
    assert.equal(hits.get('/services/data') || 0, 1, 'org max versions should be discovered once');
    const warning = getApiVersionFallbackWarning(auth);
    assert.ok(warning?.includes('sourceApiVersion 66.0 > org max 64.0'), 'should expose fallback warning');
  });
});
