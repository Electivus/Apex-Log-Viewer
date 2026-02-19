import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { fetchApexLogBody, __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';

suite('https request timeout', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
  });

  test('rejects when request exceeds timeout', async () => {
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com', username: 'user' };

    __setHttpsRequestImplForTests(((_opts: any, _cb: any) => {
      const req = new EventEmitter() as any;
      req.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      req.setTimeout = (ms: number, cb: () => void) => {
        setTimeout(cb, ms);
        return req;
      };
      req.setHeader = () => {};
      req.write = () => {};
      req.end = () => {};
      return req;
    }) as any);

    await assert.rejects(fetchApexLogBody(auth, 'LOG', 50), /timed out/i);
  });
});
