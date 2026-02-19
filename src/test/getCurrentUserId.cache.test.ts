import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { getCurrentUserId, __resetUserIdCacheForTests } from '../salesforce/traceflags';
import { __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';

suite('getCurrentUserId caching', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetUserIdCacheForTests();
  });

  test('reuses cached user id', async () => {
    const auth: OrgAuth = {
      accessToken: 't',
      instanceUrl: 'https://example.com',
      username: 'a@example.com'
    } as OrgAuth;
    let called = 0;
    __setHttpsRequestImplForTests((opts: any, cb: any) => {
      called++;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = {};
        res.on = function (event: string, listener: any) {
          EventEmitter.prototype.on.call(this, event, listener);
          return this;
        };
        res.setEncoding = () => {};
        res.req = req;
        cb(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(JSON.stringify({ records: [{ Id: '005xx0000012345' }] })));
          res.emit('end');
        });
      };
      return req;
    });

    const first = await getCurrentUserId(auth);
    const second = await getCurrentUserId(auth);
    assert.equal(first, '005xx0000012345');
    assert.equal(second, '005xx0000012345');
    assert.equal(called, 1, 'expected single HTTP request');
  });
});
