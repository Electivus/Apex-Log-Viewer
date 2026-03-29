import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { fetchApexLogBody, __setHttpsRequestImplForTests, __resetHttpsRequestImplForTests } from '../../../../src/salesforce/http';
import { __resetConnectionFactoryForTests, __setConnectionFactoryForTests } from '../../../../src/salesforce/jsforce';
import type { OrgAuth } from '../../../../src/salesforce/types';

suite('https request timeout', () => {
  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetConnectionFactoryForTests();
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

  test('rejects promptly when a jsforce-backed request is aborted', async () => {
    const auth: OrgAuth = { accessToken: 't', instanceUrl: 'https://example.com', username: 'user' };
    const controller = new AbortController();
    const stream = new PassThrough();
    let destroyed = false;
    const originalDestroy = stream.destroy.bind(stream);
    (stream as any).destroy = (...args: any[]) => {
      destroyed = true;
      return originalDestroy(...args);
    };

    __setConnectionFactoryForTests(async () => ({
      version: '64.0',
      instanceUrl: auth.instanceUrl,
      accessToken: auth.accessToken,
      query: async () => ({ records: [] }),
      queryMore: async () => ({ records: [] }),
      tooling: {
        query: async () => ({ records: [] }),
        create: async () => ({ success: true, id: '1', errors: [] }),
        update: async () => ({ success: true, id: '1', errors: [] }),
        destroy: async () => ({ success: true, id: '1', errors: [] })
      },
      streaming: {} as any,
      request: () => {
        const promise = new Promise<string>(() => {}) as Promise<string> & { stream: () => PassThrough };
        promise.stream = () => stream;
        return promise;
      }
    }) as any);

    const pending = fetchApexLogBody(auth, 'LOG', undefined, controller.signal);
    controller.abort();

    await assert.rejects(pending, /aborted/i);
    assert.equal(destroyed, true);
  });
});
