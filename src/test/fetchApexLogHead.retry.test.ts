import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { fetchApexLogHead, __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../salesforce/http';
import { __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce/exec';
import type { OrgAuth } from '../salesforce/types';

suite('fetchApexLogHead retry', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetExecFileImplForTests();
  });

  test('cancels second request when line limit reached after retry', async () => {
    const auth: OrgAuth = { accessToken: 't1', instanceUrl: 'https://example.com', username: 'user' };

    __setExecFileImplForTests(((_file: string, _args: readonly string[] | undefined, _opts: any, cb: any) => {
      const stdout = JSON.stringify({
        result: { accessToken: 't2', instanceUrl: 'https://example.com', username: 'user' }
      });
      cb(null, stdout, '');
      return undefined as any;
    }) as any);

    let call = 0;
    let destroyed = false;
    let destroyedId = 0;
    const stub: any = (_opts: any, cb: any) => {
      const callId = ++call;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        if (callId === 1) {
          // First call: Range attempt returns 401 and ends
          const res = new EventEmitter() as any;
          res.statusCode = 401;
          res.setEncoding = () => {};
          res.resume = () => {};
          res.req = req;
          process.nextTick(() => {
            cb(res);
            process.nextTick(() => res.emit('end'));
          });
        } else if (callId === 2) {
          // Second call: Range retry returns 200 (not 206) and ends
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          res.setEncoding = () => {};
          res.req = req;
          process.nextTick(() => {
            cb(res);
            process.nextTick(() => res.emit('end'));
          });
        } else {
          // Third call: streaming fallback returns 200 and emits lines
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          res.setEncoding = () => {};
          res.req = req;
          process.nextTick(() => {
            cb(res);
            process.nextTick(() => {
              res.emit('data', 'line1\n');
              res.emit('data', 'line2\n');
              res.emit('data', 'line3\n');
              process.nextTick(() => res.emit('end'));
            });
          });
        }
      };
      req.destroy = () => {
        destroyed = true;
        destroyedId = callId;
      };
      return req;
    };
    __setHttpsRequestImplForTests(stub);

    const lines = await fetchApexLogHead(auth, 'LOG', 2);
    assert.deepEqual(lines, ['line1', 'line2']);
    assert.equal(call, 3);
    assert.ok(destroyed && destroyedId >= 3, 'stream request should be destroyed');
  });
});
