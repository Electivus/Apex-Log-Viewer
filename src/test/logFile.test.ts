import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import type { OrgAuth } from '../salesforce/types';

suite('ensureLogFile', () => {
  test('fetches and writes when missing', async () => {
    const writes: any[] = [];
    const { ensureLogFile } = proxyquire('../utils/logFile', {
      '../salesforce/http': {
        fetchApexLogBody: async (_auth: OrgAuth, id: string) => `body-${id}`
      },
      './workspace': {
        findExistingLogFile: async () => undefined,
        getLogFilePathWithUsername: async (username: string | undefined, id: string) => ({
          filePath: `/tmp/${username}-${id}.log`
        })
      },
      fs: { promises: { writeFile: async (...args: any[]) => writes.push(args) } }
    });
    const auth = { username: 'user' } as OrgAuth;
    const path = await ensureLogFile(auth, '123');
    assert.equal(path, '/tmp/user-123.log');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], ['/tmp/user-123.log', 'body-123', 'utf8']);
  });

  test('returns existing path without fetching', async () => {
    let fetched = false;
    const { ensureLogFile } = proxyquire('../utils/logFile', {
      '../salesforce/http': {
        fetchApexLogBody: async () => {
          fetched = true;
          return '';
        }
      },
      './workspace': {
        findExistingLogFile: async () => '/existing',
        getLogFilePathWithUsername: async () => ({ filePath: '/tmp/unused' })
      },
      fs: { promises: { writeFile: async () => { throw new Error('writeFile should not be called'); } } }
    });
    const auth = { username: 'user' } as OrgAuth;
    const path = await ensureLogFile(auth, 'abc');
    assert.equal(path, '/existing');
    assert.equal(fetched, false);
  });
});

