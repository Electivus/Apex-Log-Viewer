import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { AuthInfo, StateAggregator, type AuthFields } from '@salesforce/core';

import { createApexLogViewerCore } from '../src/index.ts';
import { PersistentAuthInfo } from '../src/orgAuth.ts';
import { ORG_ID, isolateSalesforceHome, startSalesforceDouble } from './support/salesforceDouble.ts';

isolateSalesforceHome();

// @salesforce/core 9.2 keeps a field's value from the auth file when the file's mtime is later than the stamp the
// in-memory change got, and stamps with performance.timeOrigin + performance.now(). That clock is anchored when the
// process starts, so it trails every new file time once the wall clock moves ahead of it: a clock step or time sync,
// a resume on Linux, whose monotonic clock stops while suspended, Windows' coarse reading of the anchor, or the clock of
// a long-lived Mac process falling behind.
function trailStampClock(t: test.TestContext, ms: number): void {
  const own = Object.getOwnPropertyDescriptor(globalThis.performance, 'timeOrigin');
  const origin = performance.timeOrigin - ms;
  Object.defineProperty(globalThis.performance, 'timeOrigin', { get: () => origin, configurable: true });
  t.after(() => {
    if (own) Object.defineProperty(globalThis.performance, 'timeOrigin', own);
    else delete (globalThis.performance as { timeOrigin?: number }).timeOrigin;
  });
}

test('each token refresh keeps its new tokens while the auth stamp clock trails the auth file by ten seconds', async t => {
  let issued = 0;
  let sessionExpired = false;
  const double = await startSalesforceDouble(t, request => {
    if (request.path === '/services/oauth2/token') {
      issued += 1;
      sessionExpired = false;
      return {
        body: {
          access_token: `token-${issued}`,
          refresh_token: `refresh-token-${issued}`,
          instance_url: double.instanceUrl,
          id: `${double.instanceUrl}/id/${ORG_ID}/005000000000001AAA`,
          token_type: 'Bearer',
          issued_at: String(Date.now()),
          signature: 'signature-double'
        }
      };
    }
    if (sessionExpired) {
      return { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }] };
    }
    return { body: { totalSize: 0, done: true, records: [] } };
  });

  const username = 'refreshed-in-a-row@example.com';
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: double.instanceUrl,
    loginUrl: double.instanceUrl,
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI'
  });
  await state.orgs.write(username);
  trailStampClock(t, 10_000);

  const core = createApexLogViewerCore({ surface: 'cli' });
  t.after(() => core.dispose());

  const kept: { refreshed: string; stored: string; persisted?: string; persistedRefreshToken?: string }[] = [];
  for (let i = 1; i <= 5; i += 1) {
    sessionExpired = true;
    const refreshed = (await core.org.getAuth({ username, refresh: true })).accessToken;
    const stored = (await core.org.getAuth({ username })).accessToken;
    const persisted = await state.orgs.peek(username, true);
    kept.push({
      refreshed,
      stored,
      persisted: persisted?.accessToken,
      persistedRefreshToken: persisted?.refreshToken
    });
  }

  assert.equal(issued, 5, 'each refresh asked the token endpoint once');
  assert.deepEqual(
    kept,
    [1, 2, 3, 4, 5].map(i => ({
      refreshed: `token-${i}`,
      stored: `token-${i}`,
      persisted: `token-${i}`,
      persistedRefreshToken: `refresh-token-${i}`
    }))
  );
});

async function loadedBeforeAnotherProcessSaved(username: string): Promise<PersistentAuthInfo> {
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: 'http://127.0.0.1:9',
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI',
    instanceApiVersion: '62.0'
  });
  await state.orgs.write(username);
  const ours = await PersistentAuthInfo.create({ username });

  // A second StateAggregator reads and writes the auth file on its own, as another process would.
  await StateAggregator.clearInstanceAsync();
  await saveAsAnotherProcess(username, { accessToken: 'token-other', refreshToken: 'refresh-token-other' });
  return ours;
}

// The other process saves through PersistentAuthInfo too, so that its own save cannot lose to #1449 on Windows.
async function saveAsAnotherProcess(username: string, fields: AuthFields): Promise<void> {
  await (await PersistentAuthInfo.create({ username })).save(fields);
}

// NTFS gave 1761 of 2000 back-to-back writes on the lab VM the same mtime, and no file time can order two writes
// within one tick. Waits until a new write in the auth file's folder gets a later mtime than the auth file.
async function untilFileTimesPass(username: string): Promise<void> {
  const file = (await StateAggregator.getInstance()).orgs.getPath(username);
  const probe = `${file}.clock`;
  const { mtimeNs } = await fs.stat(file, { bigint: true });
  try {
    for (;;) {
      await fs.writeFile(probe, '');
      if ((await fs.stat(probe, { bigint: true })).mtimeNs > mtimeNs) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  } finally {
    await fs.rm(probe, { force: true });
  }
}

async function persistedAfter(ours: AuthInfo, username: string): Promise<Record<string, unknown>> {
  const persisted = await (await StateAggregator.getInstance()).orgs.peek(username, true);
  return {
    accessToken: ours.getFields(true).accessToken,
    persistedAccessToken: persisted?.accessToken,
    persistedRefreshToken: persisted?.refreshToken,
    persistedApiVersion: persisted?.instanceApiVersion
  };
}

const keptBoth = {
  accessToken: 'token-other',
  persistedAccessToken: 'token-other',
  persistedRefreshToken: 'refresh-token-other',
  persistedApiVersion: '63.0'
};

test('a save while the stamp clock trails keeps its own change and the token another process saved since', async t => {
  const username = 'two-writers@example.com';
  const ours = await loadedBeforeAnotherProcessSaved(username);

  trailStampClock(t, 10_000);
  await ours.save({ instanceApiVersion: '63.0' });

  assert.deepEqual(await persistedAfter(ours, username), keptBoth);
});

// The library's refresh path updates with every auth field again after re-reading the file; a field it repeats
// unchanged is not a change of ours.
test('a save that repeats the tokens it holds keeps the token another process saved since', async t => {
  const username = 'two-writers-repeated@example.com';
  const ours = await loadedBeforeAnotherProcessSaved(username);

  trailStampClock(t, 10_000);
  await ours.save({ accessToken: 'token-0', refreshToken: 'refresh-token-0', instanceApiVersion: '63.0' });

  assert.deepEqual(await persistedAfter(ours, username), keptBoth);
});

test('a change loses to a later write of the same field by another process before the save', async t => {
  const username = 'written-between-update-and-save@example.com';
  const ours = await loadedBeforeAnotherProcessSaved(username);

  trailStampClock(t, 10_000);
  ours.update({ instanceApiVersion: '63.0' });
  await untilFileTimesPass(username);
  await StateAggregator.clearInstanceAsync();
  await saveAsAnotherProcess(username, { instanceApiVersion: '64.0' });
  await ours.save();

  await StateAggregator.clearInstanceAsync();
  const persisted = await (await StateAggregator.getInstance()).orgs.peek(username, true);
  assert.deepEqual(
    { accessToken: persisted?.accessToken, instanceApiVersion: persisted?.instanceApiVersion },
    { accessToken: 'token-other', instanceApiVersion: '64.0' }
  );
});

// The library sets every field again on each update, so a change of an earlier update needs keeping too.
test('a save after two updates keeps both changes while the stamp clock trails', async t => {
  const username = 'updated-twice@example.com';
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: 'http://127.0.0.1:9',
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI',
    instanceApiVersion: '62.0'
  });
  await state.orgs.write(username);
  const ours = await PersistentAuthInfo.create({ username });

  trailStampClock(t, 10_000);
  ours.update({ accessToken: 'token-1' });
  ours.update({ instanceApiVersion: '63.0' });
  await ours.save();

  await StateAggregator.clearInstanceAsync();
  const persisted = await (await StateAggregator.getInstance()).orgs.peek(username, true);
  assert.deepEqual(
    { accessToken: persisted?.accessToken, instanceApiVersion: persisted?.instanceApiVersion },
    { accessToken: 'token-1', instanceApiVersion: '63.0' }
  );
});

test('a save leaves the tokens another process rotates right after it writes', async t => {
  const username = 'rotated-after-our-save@example.com';
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    instanceUrl: 'http://127.0.0.1:9',
    accessToken: 'token-0',
    refreshToken: 'refresh-token-0',
    clientId: 'PlatformCLI',
    instanceApiVersion: '62.0'
  });
  await state.orgs.write(username);
  const ours = await PersistentAuthInfo.create({ username });

  // The moment the library's first write of our save returns, a second StateAggregator, as another process would,
  // loads the auth file and saves the tokens a refresh-token rotation gave it. The rotated-out refresh token is dead
  // from then on.
  const librarySave = AuthInfo.prototype.save;
  let rotatedTo: string | undefined;
  AuthInfo.prototype.save = async function (this: AuthInfo, ...args: Parameters<AuthInfo['save']>) {
    const saved = await librarySave.apply(this, args);
    if (this === ours && !rotatedTo) {
      rotatedTo = 'none';
      await StateAggregator.clearInstanceAsync();
      await saveAsAnotherProcess(username, { accessToken: 'token-rotated', refreshToken: 'refresh-token-rotated' });
      rotatedTo = (await (await StateAggregator.getInstance()).orgs.peek(username, true))?.refreshToken ?? 'none';
    }
    return saved;
  };
  t.after(() => {
    AuthInfo.prototype.save = librarySave;
  });

  trailStampClock(t, 10_000);
  await ours.save({ instanceApiVersion: '63.0' });

  await StateAggregator.clearInstanceAsync();
  const persisted = await (await StateAggregator.getInstance()).orgs.peek(username, true);
  assert.equal(rotatedTo, 'refresh-token-rotated', 'the other process stored its rotation after our first write');
  assert.deepEqual(
    {
      accessToken: persisted?.accessToken,
      refreshToken: persisted?.refreshToken,
      instanceApiVersion: persisted?.instanceApiVersion
    },
    { accessToken: 'token-rotated', refreshToken: 'refresh-token-rotated', instanceApiVersion: '63.0' }
  );
});
