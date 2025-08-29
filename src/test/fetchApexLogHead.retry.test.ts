import assert from 'assert/strict';
import * as https from 'https';
import { EventEmitter } from 'events';
import { fetchApexLogHead, OrgAuth, __setExecFileImplForTests, __resetExecFileImplForTests } from '../salesforce';

suite('fetchApexLogHead retry', () => {
  teardown(() => {
    (https as any).request = originalRequest;
    __resetExecFileImplForTests();
  });

  const originalRequest = https.request;

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
    let secondDestroyed = false;
    (https as any).request = (_opts: any, cb: any) => {
      const callId = ++call;
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.end = () => {
        if (callId === 1) {
          const res = new EventEmitter() as any;
          res.statusCode = 401;
          res.setEncoding = () => {};
          res.resume = () => {};
          res.req = req;
          process.nextTick(() => cb(res));
        } else {
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
            });
          });
        }
      };
      req.destroy = () => {
        if (callId === 2) {
          secondDestroyed = true;
        }
      };
      return req;
    };

    const lines = await fetchApexLogHead(auth, 'LOG', 2);
    assert.deepEqual(lines, ['line1', 'line2']);
    assert.equal(call, 2);
    assert.ok(secondDestroyed, 'second request should be destroyed');
  });
});
