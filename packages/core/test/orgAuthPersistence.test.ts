import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthInfo, StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { ORG_ID, isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// @salesforce/core 9.4 stamps an in-memory auth change in whole milliseconds and merges it with the auth file
// by the file's nanosecond mtime, so a save soon after the previous one can lose to it and leave the old token.
// Token refreshes persist through AuthInfo.save, and both surfaces read the token back through core.org.getAuth.
// On a Windows Server 2025 VM with NTFS, 9.2.0 lost 1 to 36 of 100 tokens in 15 of 30 runs (#1449). There the test
// is a todo: node:test still runs it and prints the lost tokens, but a failure does not fail the run.
const windowsLoss = process.platform === 'win32' ? '9.2.0 also loses back-to-back saves on Windows (#1449)' : false;

test(
  'each of 100 back-to-back auth saves leaves its own access token for core.org.getAuth',
  { todo: windowsLoss },
  async t => {
    const username = 'saved-in-a-row@example.com';
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

    const info = await AuthInfo.create({ username });
    const core = createApexLogViewerCore({ surface: 'cli' });
    t.after(() => core.dispose());

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
  }
);
