import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthInfo, StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { PersistentAuthInfo } from '../src/orgAuth.ts';
import { ORG_ID, isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// @salesforce/core merges the auth file into memory on each save and keeps the file's value when its mtime is later
// than the stamp of the in-memory change, so a save soon after the previous one can keep the old token (#1449).
// 9.4 stamps in whole milliseconds. 9.2 stamps from a clock that starts from the wall clock at process start and then
// counts on its own. Token refreshes persist through the auth info core connects with, and both surfaces read the
// token back through core.org.getAuth.
async function saveInARow(username: string, info: AuthInfo): Promise<void> {
  const core = createApexLogViewerCore({ surface: 'cli' });
  try {
    // Reading through core after every save would space the saves out past the millisecond the loss needs, so
    // only a save whose token the auth info no longer holds is read back through core.
    const lost: string[] = [];
    for (let i = 1; i <= 100; i += 1) {
      const expected = `token-${i}`;
      await info.save({ accessToken: expected });
      if (info.getFields(true).accessToken !== expected) {
        lost.push(`${expected} read back as ${(await core.org.getAuth({ username })).accessToken}`);
      }
    }
    assert.deepEqual(lost, [], `${lost.length} of 100 saves lost their token`);
    assert.equal((await core.org.getAuth({ username })).accessToken, 'token-100');
  } finally {
    core.dispose();
  }
}

async function seedAuth(username: string): Promise<void> {
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: 'http://127.0.0.1:9',
    accessToken: 'token-0',
    refreshToken: 'refresh-token-double',
    clientId: 'PlatformCLI'
  });
  await state.orgs.write(username);
}

// The library's own AuthInfo, kept as the canary that tells 9.2 from 9.4 before a @salesforce/core update (#1425).
// It is enforced on Linux, where 9.2.0 kept every token in CI and in a container and 9.4.6 lost 15 to 34 in all 8
// runs. 9.2.0 itself loses on the other two systems, measured for #1449. Node on Windows reads the start of the stamp
// clock from the coarse system clock: on a Windows Server 2025 VM, 12 of 30 new processes started up to 2 ms behind
// NTFS mtimes and lost saves. On a Mac the stamp clock fell 0.34 ms a minute behind the wall clock, and macOS CI
// runners lost tokens in 2 of 9 runs. There node:test still runs it and prints the lost tokens without failing.
const libraryLossOn9_2 =
  process.platform === 'win32' || process.platform === 'darwin'
    ? `@salesforce/core 9.2.0 itself loses back-to-back saves on ${process.platform} (#1449)`
    : false;

test(
  "canary: @salesforce/core's own AuthInfo keeps each of 100 back-to-back saves",
  { todo: libraryLossOn9_2 },
  async () => {
    const username = 'library-saved-in-a-row@example.com';
    await seedAuth(username);
    await saveInARow(username, await AuthInfo.create({ username }));
  }
);

test('each of 100 back-to-back auth saves leaves its own access token for core.org.getAuth', async () => {
  const username = 'saved-in-a-row@example.com';
  await seedAuth(username);
  await saveInARow(username, await PersistentAuthInfo.create({ username }));
});
