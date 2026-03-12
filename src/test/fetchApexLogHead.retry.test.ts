import assert from 'assert/strict';
import { PassThrough } from 'stream';
import { fetchApexLogHead } from '../salesforce/http';
import { __setConnectionFactoryForTests, __resetConnectionFactoryForTests } from '../salesforce/jsforce';
import type { OrgAuth } from '../salesforce/types';

suite('fetchApexLogHead retry', () => {
  teardown(() => {
    __resetConnectionFactoryForTests();
  });

  test('returns the requested prefix of lines from the jsforce stream', async () => {
    const auth: OrgAuth = { accessToken: 't1', instanceUrl: 'https://example.com', username: 'user' };
    let requestCalls = 0;
    const stream = new PassThrough();
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
        requestCalls++;
        const promise = Promise.resolve('line1\nline2\nline3\n') as Promise<string> & { stream: () => PassThrough };
        promise.stream = () => stream;
        process.nextTick(() => {
          stream.write('line1\n');
          stream.write('line2\n');
          stream.write('line3\n');
          stream.end();
        });
        return promise;
      }
    }) as any);

    const lines = await fetchApexLogHead(auth, 'LOG', 2);
    assert.deepEqual(lines, ['line1', 'line2']);
    assert.equal(requestCalls, 1);
  });
});
