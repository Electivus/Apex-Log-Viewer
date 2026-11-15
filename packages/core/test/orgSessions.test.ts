import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError, createSessionConnection, usableAccessToken } from '../src/index.ts';
import { createOrgSessions, renewalFailureOf, type OrgSession, type SourceOrg } from '../src/orgSessions.ts';
import { salesforceError, startSalesforceDouble } from './support/salesforceDouble.ts';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type SessionAsk = { username: string; reason: 'first-use' | 'rejected'; answer: Deferred<OrgSession> };

/** An auth source whose every session answer the test gives by hand, in the order it was asked. */
function scriptedSource(orgs: SourceOrg[]) {
  const asks: SessionAsk[] = [];
  let listed = [...orgs];
  let lists = 0;
  return {
    asks,
    lists: () => lists,
    setOrgs(next: SourceOrg[]) {
      listed = [...next];
    },
    source: {
      async listOrgs() {
        lists += 1;
        return listed;
      },
      session(org: SourceOrg, reason: 'first-use' | 'rejected') {
        const answer = deferred<OrgSession>();
        asks.push({ username: org.username, reason, answer });
        return answer.promise;
      }
    }
  };
}

const INSTANCE = 'https://sessions.example.com';
const org: SourceOrg = { username: 'sessions@example.com', alias: 'sessions', instanceUrl: INSTANCE, orgId: '00D1' };
const session = (accessToken: string): OrgSession => ({ accessToken, instanceUrl: INSTANCE, orgId: '00D1' });
const isAuthRequired = (error: unknown) => error instanceof AlvError && error.code === 'AUTH_REQUIRED';
const isAborted = (error: unknown) => error instanceof AlvError && error.code === 'ABORTED';

/** A session cell already holding `token`. */
async function holding(token: string) {
  const scripted = scriptedSource([org]);
  const sessions = createOrgSessions(scripted.source);
  const first = sessions.current(org);
  scripted.asks[0]!.answer.resolve(session(token));
  await first;
  return { scripted, sessions };
}

test('concurrent first uses of an org share one session from the source', async () => {
  const scripted = scriptedSource([org]);
  const sessions = createOrgSessions(scripted.source);

  const callers = Array.from({ length: 5 }, () => sessions.current(org));
  assert.equal(scripted.asks.length, 1);
  scripted.asks[0]!.answer.resolve(session('t1'));

  assert.deepEqual(await Promise.all(callers), Array(5).fill(session('t1')));
  assert.deepEqual(await sessions.current(org), session('t1'));
  assert.deepEqual(
    scripted.asks.map(ask => ask.reason),
    ['first-use']
  );
});

test('concurrent renewals of one rejected token ask the source once', async () => {
  const { scripted, sessions } = await holding('t1');

  const callers = Array.from({ length: 5 }, () => sessions.renew(org, 't1'));
  assert.deepEqual(
    scripted.asks.map(ask => ask.reason),
    ['first-use', 'rejected']
  );
  scripted.asks[1]!.answer.resolve(session('t2'));

  assert.deepEqual(await Promise.all(callers), Array(5).fill(session('t2')));
  assert.deepEqual(await sessions.current(org), session('t2'));
});

test('a renewal of a token already replaced answers with the newer session without the source', async () => {
  const { scripted, sessions } = await holding('t1');
  const renewal = sessions.renew(org, 't1');
  scripted.asks[1]!.answer.resolve(session('t2'));
  await renewal;

  assert.deepEqual(await sessions.renew(org, 't1'), session('t2'));
  assert.equal(scripted.asks.length, 2);
});

test('a source that hands back the rejected token ends with AUTH_REQUIRED, and the next use asks again', async () => {
  const { scripted, sessions } = await holding('t1');

  const renewal = sessions.renew(org, 't1');
  scripted.asks[1]!.answer.resolve(session('t1'));
  await assert.rejects(renewal, isAuthRequired);

  const next = sessions.current(org);
  assert.deepEqual(
    scripted.asks.map(ask => ask.reason),
    ['first-use', 'rejected', 'first-use']
  );
  scripted.asks[2]!.answer.resolve(session('t3'));
  assert.deepEqual(await next, session('t3'));
});

test('a failed session is not kept: the next use asks the source again', async () => {
  const scripted = scriptedSource([org]);
  const sessions = createOrgSessions(scripted.source);

  const first = sessions.current(org);
  scripted.asks[0]!.answer.reject(new Error('sf failed'));
  await assert.rejects(first, /sf failed/);

  const second = sessions.current(org);
  scripted.asks[1]!.answer.resolve(session('t1'));
  assert.deepEqual(await second, session('t1'));
});

test("one caller's abort does not cancel the session others wait for", async () => {
  const scripted = scriptedSource([org]);
  const sessions = createOrgSessions(scripted.source);
  const cancelled = new AbortController();

  const abandoned = sessions.current(org, cancelled.signal);
  const awaited = sessions.current(org);
  cancelled.abort();
  await assert.rejects(abandoned, isAborted);
  scripted.asks[0]!.answer.resolve(session('t1'));
  assert.deepEqual(await awaited, session('t1'));

  const stopped = new AbortController();
  const abandonedRenewal = sessions.renew(org, 't1', stopped.signal);
  const awaitedRenewal = sessions.renew(org, 't1');
  stopped.abort();
  await assert.rejects(abandonedRenewal, isAborted);
  scripted.asks[1]!.answer.resolve(session('t2'));
  assert.deepEqual(await awaitedRenewal, session('t2'));
  assert.equal(scripted.asks.length, 2);
});

test('resolve finds an org by username in any case, by alias, or as the default', async () => {
  const other: SourceOrg = { username: 'other@example.com', isDefaultUsername: true };
  const scripted = scriptedSource([org, other]);
  const sessions = createOrgSessions(scripted.source);

  assert.equal((await sessions.resolve('SESSIONS@Example.com')).org, org);
  assert.deepEqual(await sessions.resolve('sessions'), { requested: 'sessions', org, source: 'alias' });
  assert.deepEqual(await sessions.resolve(undefined), {
    requested: 'other@example.com',
    org: other,
    source: 'username'
  });
  assert.equal(scripted.lists(), 1, 'names the list holds resolve from memory');
});

test('a name the list misses is looked up in one new list, then reported', async () => {
  const late: SourceOrg = { username: 'late@example.com' };
  const scripted = scriptedSource([org]);
  const sessions = createOrgSessions(scripted.source);
  await sessions.orgs();

  scripted.setOrgs([org, late]);
  assert.equal((await sessions.resolve('late@example.com')).org, late);
  assert.equal(scripted.lists(), 2);

  await assert.rejects(
    sessions.resolve('missing@example.com'),
    /No authorization information found for missing@example\.com/
  );
  assert.equal(scripted.lists(), 3);
  await assert.rejects(sessions.resolve(undefined), /No default Salesforce org is configured/);
});

test('the org list is memoized until asked fresh, and a failed list is not kept', async () => {
  let lists = 0;
  let failNext = true;
  const sessions = createOrgSessions({
    async listOrgs() {
      lists += 1;
      if (failNext) {
        failNext = false;
        throw new Error('sf is busy');
      }
      return [org];
    },
    session: async () => session('t1')
  });

  await assert.rejects(sessions.orgs(), /sf is busy/);
  assert.deepEqual(await sessions.orgs(), [org]);
  assert.deepEqual(await sessions.orgs(), [org]);
  assert.equal(lists, 2);
  await sessions.orgs({ fresh: true });
  assert.equal(lists, 3);
});

test('usableAccessToken refuses what newer CLIs print in place of a token', () => {
  for (const placeholder of [
    '',
    '   ',
    '[REDACTED]',
    'redacted',
    'Use "sf org auth show-access-token" to see your access token.',
    undefined,
    42
  ]) {
    assert.equal(usableAccessToken(placeholder), undefined, String(placeholder));
  }
  assert.equal(usableAccessToken(' 00D000000000001!AQEAQ.token '), '00D000000000001!AQEAQ.token');
});

/** An org that accepts only the tokens in `accepted`, and answers a query with one record. */
async function tokenCheckingOrg(t: test.TestContext, accepted: Set<string>) {
  return startSalesforceDouble(t, request =>
    accepted.has(request.token)
      ? { body: { totalSize: 0, done: true, records: [] } }
      : salesforceError('INVALID_SESSION_ID', 'Session expired or invalid', 401)
  );
}

const query = (connection: ReturnType<typeof createSessionConnection>) =>
  connection.query('SELECT Id FROM User').catch((error: unknown) => {
    throw renewalFailureOf(connection, error);
  });

test('a session connection renews a rejected token through renew and retries the request', async t => {
  const accepted = new Set(['t2']);
  const salesforce = await tokenCheckingOrg(t, accepted);
  const renewals: string[] = [];
  const renewed = ['t2', 't3'];
  const connection = createSessionConnection({
    username: org.username,
    session: { accessToken: 't1', instanceUrl: salesforce.instanceUrl },
    version: '63.0',
    renew: async rejected => {
      renewals.push(rejected);
      return { accessToken: renewed.shift()!, instanceUrl: salesforce.instanceUrl };
    }
  });

  assert.equal((await query(connection)).totalSize, 0);
  assert.deepEqual(renewals, ['t1']);

  accepted.clear();
  accepted.add('t3');
  assert.equal((await query(connection)).totalSize, 0, 'a renewed session that worked may be renewed again');
  assert.deepEqual(renewals, ['t1', 't2']);
  assert.deepEqual(
    salesforce.requests.map(request => request.token),
    ['t1', 't2', 't2', 't3']
  );
});

test('a renewed token rejected before any request succeeded with it ends with AUTH_REQUIRED', async t => {
  const salesforce = await tokenCheckingOrg(t, new Set());
  const renewals: string[] = [];
  const connection = createSessionConnection({
    username: org.username,
    session: { accessToken: 't1', instanceUrl: salesforce.instanceUrl },
    version: '63.0',
    renew: async rejected => {
      renewals.push(rejected);
      return { accessToken: 't2', instanceUrl: salesforce.instanceUrl };
    }
  });

  await assert.rejects(query(connection), isAuthRequired);
  assert.deepEqual(renewals, ['t1']);
  assert.deepEqual(
    salesforce.requests.map(request => request.token),
    ['t1', 't2']
  );
});

test("a session connection reports the renewal's own error, not jsforce's wrapper", async t => {
  const salesforce = await tokenCheckingOrg(t, new Set());
  const failure = new AlvError('SF_CLI_FAILED', 'sf could not refresh the session');
  const connection = createSessionConnection({
    username: org.username,
    session: { accessToken: 't1', instanceUrl: salesforce.instanceUrl },
    version: '63.0',
    renew: async () => {
      throw failure;
    }
  });

  await assert.rejects(query(connection), error => error === failure);
});
