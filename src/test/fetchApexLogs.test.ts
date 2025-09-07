import assert from 'assert/strict';
import { EventEmitter } from 'events';
import {
  fetchApexLogs,
  clearListCache,
  __setHttpsRequestImplForTests,
  __resetHttpsRequestImplForTests,
  __getListCacheSizeForTests,
  __getListCacheLimitForTests,
  __forceExpireListCacheForTests
} from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';

suite('fetchApexLogs', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
    clearListCache();
  });

  test('uses cache for repeated calls', async () => {
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
    assert.deepEqual(second, first, 'cached result should match');
    assert.equal(calls, 1, 'network should be called once due to cache');
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

  test('prunes expired cache entries', async () => {
    const auth: OrgAuth = {
      accessToken: 'tok',
      instanceUrl: 'https://example.com',
      username: 'user'
    };

    const body = JSON.stringify({ records: [] });
    __setHttpsRequestImplForTests((options: any, cb: any) => {
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

    await fetchApexLogs(auth, 50, 0);
    __forceExpireListCacheForTests();
    await fetchApexLogs(auth, 50, 1);
    assert.equal(__getListCacheSizeForTests(), 1, 'expired entries should be removed');
  });

  test('enforces cache size limit', async () => {
    const auth: OrgAuth = {
      accessToken: 'tok',
      instanceUrl: 'https://example.com',
      username: 'user'
    };

    const body = JSON.stringify({ records: [] });
    __setHttpsRequestImplForTests((options: any, cb: any) => {
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

    const limit = __getListCacheLimitForTests();
    for (let i = 0; i < limit + 5; i++) {
      await fetchApexLogs(auth, 50, i);
    }
    assert.equal(__getListCacheSizeForTests(), limit, 'list cache should not exceed configured limit');
  });
});
