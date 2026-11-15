import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthInfo, StateAggregator } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { ORG_ID, isolateSalesforceHome } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// @salesforce/core 9.4 stamps an in-memory auth change in whole milliseconds and merges it with the auth file
// by the file's nanosecond mtime, so a save soon after the previous one can lose to it and leave the old token.
// Token refreshes persist through AuthInfo.save, and both surfaces read the token back through core.org.getAuth.
// 9.2.0 loses some of these saves too, on some systems (#1449). Measured on 9.2.0: a Windows Server 2025 VM with
// NTFS lost 1 to 36 of 100 tokens in 15 of 30 runs; macOS CI runners lost 35 and 27 in 2 of 9 runs, for a cause
// not yet measured; Linux lost none, in CI and in a container, where 9.4.6 lost 15 to 34 in all 8 runs. So the
// test is a todo on Windows and macOS, where node:test still runs it and prints the lost tokens without failing the
// run, and it is enforced on Linux, where it tells 9.2.0 from 9.4.6.
const lossOn9_2 =
  process.platform === 'win32' || process.platform === 'darwin'
    ? `9.2.0 also loses back-to-back saves on ${process.platform} (#1449)`
    : false;

test(
  'each of 100 back-to-back auth saves leaves its own access token for core.org.getAuth',
  { todo: lossOn9_2 },
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
