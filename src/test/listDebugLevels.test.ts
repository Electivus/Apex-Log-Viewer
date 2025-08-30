import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { listDebugLevels } from '../salesforce/traceflags';
import { __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';

suite('listDebugLevels', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
  });

  test('parses developer names from response', async () => {
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com' };
    __setHttpsRequestImplForTests((opts: any, cb: any) => {
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
          res.emit(
            'data',
            Buffer.from(JSON.stringify({ records: [{ DeveloperName: 'DL1' }, { DeveloperName: 'DL2' }] }))
          );
          res.emit('end');
        });
      };
      return req;
    });

    const levels = await listDebugLevels(auth);
    assert.deepEqual(levels, ['DL1', 'DL2']);
  });
});
