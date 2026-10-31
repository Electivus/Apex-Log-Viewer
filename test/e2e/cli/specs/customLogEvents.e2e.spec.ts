import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type TestInfo } from '@playwright/test';
import {
  CliProcess,
  DELIVERIES_PER_RUN,
  EVENTS_ORG_ALIAS,
  EVENT_OBJECTS,
  EVENT_SOURCE_ID,
  RESTRICTED_ALIAS,
  createEventsProject,
  cursorAhead,
  deliveredBy,
  daysAgo,
  eventsOrgConfigured,
  eventsOrgUsername,
  holdClientsUntilRefused,
  probeSubscribe,
  publishEvents,
  readAllowance,
  readCheckpoint,
  readLease,
  readStoredEvents,
  runCli,
  settledAllowance,
  writeCheckpoint,
  type Allowance,
  type CliOutcome,
  type EventsProject
} from '../../utils/eventsOrg';

/**
 * Platform event capture against the real `alv-events` scratch org (`node scripts/events-org.mjs ensure`).
 * It skips on a machine that does not have the org, so the pool-only CI is untouched.
 *
 * Every scenario owns a temporary project and so its own store, filters by a unique run tag, and spends at most
 * DELIVERIES_PER_RUN deliveries. The org's daily allocation is shared by every run, so the last hook compares what the
 * scenarios report against /limits once the counter has settled. Scenarios that replay `-2` use ALV_Test_Replay__e,
 * whose retained backlog is only what these scenarios published in the last 72 hours.
 *
 * Not here: the budget outcome (it needs a backlog larger than half of the remaining allocation, so it runs once by
 * hand after the 10,000-event measurement, docs/TESTING.md) and the proxy path (pnpm run test:e2e:proxy-lab).
 */

const configured = eventsOrgConfigured();
const MIN_ALLOWANCE = 3_000;
const CAPTURE = ['custom-log', 'capture', '--source', EVENT_SOURCE_ID, '--target-org', EVENTS_ORG_ALIAS];

test.describe('Custom Logs platform event capture on the events org', () => {
  test.skip(!configured, 'The alv-events scratch org is not authenticated here: node scripts/events-org.mjs ensure.');
  test.describe.configure({ mode: 'serial' });

  const ledger: { start?: Allowance; delivered: number } = { delivered: 0 };
  const projects: EventsProject[] = [];
  /** Every command goes through here, so the ledger counts a run even when a later assertion fails. */
  const spent = (outcome: CliOutcome): CliOutcome => {
    ledger.delivered += deliveredBy(outcome);
    return outcome;
  };
  const run = async (args: string[], options: Parameters<typeof runCli>[1]): Promise<CliOutcome> =>
    spent(await runCli(args, options));
  const finish = async (process: CliProcess): Promise<CliOutcome> => spent(await process.finished());
  const projectFor = async (options: Parameters<typeof createEventsProject>[0]): Promise<EventsProject> => {
    const project = await createEventsProject(options);
    projects.push(project);
    return project;
  };

  /** Shared by the scenarios that start from the resume scenario's store. */
  let resumed: { project: EventsProject; eventsRoot: string; tags: string[] } | undefined;

  test.beforeAll(async () => {
    ledger.start = await readAllowance();
    test.skip(
      ledger.start.remaining < MIN_ALLOWANCE,
      `Only ${ledger.start.remaining} of ${ledger.start.max} event deliveries are left today; the specs need ${MIN_ALLOWANCE}.`
    );
  });

  test.afterAll(async () => {
    await Promise.all(projects.map(project => project.cleanup()));
    if (!ledger.start || ledger.delivered === 0) return;
    const settled = await settledAllowance();
    const spent = ledger.start.remaining - settled.remaining;
    console.info(
      JSON.stringify({
        events: {
          startRemaining: ledger.start.remaining,
          settledRemaining: settled.remaining,
          spent,
          reported: ledger.delivered
        }
      })
    );
    // The org has no other subscriber, so /limits must show about what the runs reported and never more.
    expect(spent).toBeLessThanOrEqual(ledger.delivered + 25);
    expect(spent).toBeGreaterThanOrEqual(Math.floor(ledger.delivered * 0.9) - 25);
  });

  async function attach(testInfo: TestInfo, label: string, outcome: CliOutcome): Promise<void> {
    await testInfo.attach(`${label}.json`, {
      body: JSON.stringify(
        { exitCode: outcome.exitCode, durationMs: outcome.durationMs, stdout: outcome.stdout, stderr: outcome.stderr },
        null,
        2
      ),
      contentType: 'application/json'
    });
  }

  /** A drain that must finish: returns the `result` of its JSON envelope. */
  async function drain(testInfo: TestInfo, project: EventsProject, label: string, args: string[] = []) {
    const outcome = await run([...CAPTURE, '--json', ...args], { cwd: project.dir });
    await attach(testInfo, label, outcome);
    expect(outcome.exitCode, outcome.stderr || outcome.stdout).toBe(0);
    const result = outcome.json.result;
    expect(result.delivered, 'one capture stays within its delivery cap').toBeLessThanOrEqual(DELIVERIES_PER_RUN);
    return { result, durationMs: outcome.durationMs };
  }

  const tagged = (events: Awaited<ReturnType<typeof readStoredEvents>>, transactionId: string) =>
    events.filter(event => event.payload.Transaction_Id__c === transactionId);

  test('resume is exact: 50 events live, 30 while stopped, then a drain delivers and stores exactly 30', async ({}, testInfo) => {
    const project = await projectFor({ object: EVENT_OBJECTS.log, gitInit: true });

    const follow = CliProcess.start([...CAPTURE, '--initial', 'new', '--follow'], { cwd: project.dir });
    await follow.waitForStderr(/Waiting for new events\./);
    const first = await publishEvents({ count: 50, transactionId: 'resume' });
    await follow.waitForStdoutLines(new RegExp(`\\(${first.runTag}\\)$`), 50);
    follow.interrupt();
    const stopped = await finish(follow);
    await attach(testInfo, 'follow', stopped);
    expect(stopped.exitCode).toBe(0);
    const summary = stopped.stderr.match(/Delivered (\d+), stored (\d+)\. Store: (.+)/);
    expect(summary, stopped.stderr).not.toBeNull();
    expect([Number(summary![1]), Number(summary![2])]).toEqual([50, 50]);
    const eventsRoot = summary![3]!.trim();

    const second = await publishEvents({ count: 30, transactionId: 'resume' });
    const { result } = await drain(testInfo, project, 'resume-drain', ['--max-time', '40']);
    expect(result).toMatchObject({ outcome: 'quiet', delivered: 30, stored: 30, newGaps: [] });
    expect(result.store).toMatchObject({ state: 'captured', gaps: [], eventsRoot });

    const events = await readStoredEvents(eventsRoot);
    const ours = [...tagged(events, first.transactionId), ...tagged(events, second.transactionId)];
    expect(tagged(events, first.transactionId)).toHaveLength(50);
    expect(tagged(events, second.transactionId)).toHaveLength(30);
    expect(new Set(ours.map(event => event.uuid)).size, 'no duplicate in the store').toBe(80);
    expect(new Set(ours.map(event => event.replayId)).size).toBe(80);
    const checkpoint = await readCheckpoint(eventsRoot);
    expect(checkpoint.cursor).toBe(
      events
        .map(event => event.replayId)
        .sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]))
        .at(-1)
    );

    const nothingNew = await drain(testInfo, project, 'resume-nothing-new', ['--max-time', '40']);
    expect(nothingNew.result).toMatchObject({ outcome: 'quiet', delivered: 0, stored: 0, newGaps: [] });

    resumed = { project, eventsRoot, tags: [first.runTag, second.runTag] };
  });

  test('list and entry read the stored events with no org connection and no Salesforce home', async ({}, testInfo) => {
    expect(resumed, 'the resume scenario ran first').toBeDefined();
    const { project, tags } = resumed!;
    const home = await mkdtemp(path.join(tmpdir(), 'alv-no-sf-home-'));
    try {
      const offline = { cwd: project.dir, env: { HOME: home, USERPROFILE: home } };
      const args = ['custom-log', 'list', '--source', EVENT_SOURCE_ID, '--target-org', eventsOrgUsername(), '--json'];
      const list = await run([...args, '--limit', '200'], offline);
      await attach(testInfo, 'offline-list', list);
      expect(list.exitCode, list.stderr || list.stdout).toBe(0);
      const rows: { id: string; title: string; transactionId: string }[] = list.json.result.rows;
      const ours = rows.filter(row => tags.some(tag => row.transactionId.endsWith(`-${tag}`)));
      expect(ours).toHaveLength(80);
      expect(list.json.result.store).toMatchObject({ state: 'captured' });
      const ids = rows.map(row => row.id);
      expect([...ids].sort().reverse(), 'rows are newest first and ids compare in list order').toEqual(ids);
      const newestFirst = ours.slice(0, 30).map(row => Number(row.title.match(/entry (\d+) of 30/)?.[1]));
      expect(newestFirst, 'the 30 published last come first, in reverse publish order').toEqual(
        Array.from({ length: 30 }, (_, index) => 30 - index)
      );

      const entry = await run(
        [
          'custom-log',
          'entry',
          '--source',
          EVENT_SOURCE_ID,
          '--target-org',
          eventsOrgUsername(),
          '--entry-id',
          ours[0]!.id,
          '--json'
        ],
        offline
      );
      await attach(testInfo, 'offline-entry', entry);
      expect(entry.exitCode, entry.stderr || entry.stdout).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('the whole delivered event is stored, the store ignores itself, and the documented rg command finds an unmapped value', async ({}, testInfo) => {
    expect(resumed).toBeDefined();
    const { project, eventsRoot, tags } = resumed!;
    const needle = `${tags[0]}-request`;
    const events = await readStoredEvents(eventsRoot);
    const sample = events.find(event => event.payload.Request_Id__c === needle)!;
    expect(sample.payload, 'unmapped fields and the user id are kept').toMatchObject({
      Request_Id__c: needle,
      CreatedById: expect.any(String),
      Payload__c: expect.stringContaining(tags[0]!)
    });

    const rg = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    test.skip(rg.status !== 0, 'ripgrep is not installed here');
    const plain = spawnSync('rg', ['-l', needle, eventsRoot], { encoding: 'utf8', cwd: project.dir });
    expect(plain.status, 'plain rg honors events/.gitignore and finds nothing').toBe(1);
    const documented = spawnSync('rg', ['--no-ignore', '-g', '*.ndjson', '-l', needle, eventsRoot], {
      encoding: 'utf8',
      cwd: project.dir
    });
    expect(documented.status, documented.stderr).toBe(0);
    expect(
      documented.stdout
        .trim()
        .split('\n')
        .every(file => file.endsWith('.ndjson'))
    ).toBe(true);

    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      cwd: project.dir
    });
    expect(status.status).toBe(0);
    expect(status.stdout.split('\n').filter(line => line.includes('/events/') || line.includes('apexlogs'))).toEqual(
      []
    );
    await testInfo.attach('git-status.txt', { body: status.stdout || '(clean)', contentType: 'text/plain' });
  });

  test('a position older than 72 hours raises retentionElapsed even though Salesforce accepts the cursor, and a fresh one does not', async ({}, testInfo) => {
    expect(resumed).toBeDefined();
    const { project, eventsRoot } = resumed!;

    await writeCheckpoint(eventsRoot, checkpoint => ({ ...checkpoint, updatedAt: daysAgo(4) }));
    const stale = await drain(testInfo, project, 'retention-elapsed', ['--max-time', '30']);
    expect(stale.result.newGaps.map((gap: { reason: string }) => gap.reason)).toEqual(['retentionElapsed']);
    expect(stale.result.delivered, 'the cursor was accepted, so nothing was replayed').toBe(0);
    expect(stale.durationMs, 'a drain over an old position waits for a backlog until --max-time').toBeGreaterThan(
      25_000
    );

    await writeCheckpoint(eventsRoot, checkpoint => ({
      ...checkpoint,
      lastEvent: { ...checkpoint.lastEvent, createdDate: daysAgo(4) },
      updatedAt: new Date().toISOString()
    }));
    const fresh = await drain(testInfo, project, 'retention-fresh', ['--max-time', '30']);
    expect(fresh.result.newGaps, 'an old last event with a fresh confirmation is no gap').toEqual([]);
    expect(
      fresh.result.store.gaps.map((gap: { reason: string }) => gap.reason),
      'the earlier gap is still reported'
    ).toEqual(['retentionElapsed']);
  });

  test('a cursor Salesforce rejects records a gap before the -2 replay, reports what the replay cost, and closes at the next event', async ({}, testInfo) => {
    const project = await projectFor({ object: EVENT_OBJECTS.replay });
    const seeded = await publishEvents({ count: 20, transactionId: 'rejected', object: EVENT_OBJECTS.replay });

    const initial = await drain(testInfo, project, 'rejected-initial', ['--initial', 'retained', '--max-time', '60']);
    const retained = initial.result.delivered;
    expect(retained).toBeGreaterThanOrEqual(20);
    expect(initial.result).toMatchObject({ outcome: 'quiet', stored: retained, newGaps: [] });
    const eventsRoot: string = initial.result.store.eventsRoot;

    const before = await readCheckpoint(eventsRoot);
    await writeCheckpoint(eventsRoot, checkpoint => ({ ...checkpoint, cursor: cursorAhead(checkpoint.cursor) }));
    const rejected = await drain(testInfo, project, 'rejected-cursor', ['--max-time', '60']);
    expect(rejected.result.newGaps).toEqual([
      expect.objectContaining({ reason: 'cursorRejected', after: before.lastEvent.createdDate })
    ]);
    expect(rejected.result.delivered, 'the -2 replay delivers every retained event, stored or not').toBe(retained);
    expect(rejected.result.stored, 'the store already holds every one of them').toBe(0);
    const copies = (await readStoredEvents(eventsRoot)).filter(event =>
      String(event.payload.Transaction_Id__c).endsWith(`-${seeded.runTag}`)
    );
    expect(copies, 'one line per event on disk').toHaveLength(seeded.published);
    const listing = await run(
      ['custom-log', 'list', '--source', EVENT_SOURCE_ID, '--target-org', EVENTS_ORG_ALIAS, '--limit', '200', '--json'],
      { cwd: project.dir }
    );
    const rows: { id: string; transactionId: string }[] = listing.json.result.rows.filter(
      (row: { transactionId: string }) => row.transactionId.endsWith(`-${seeded.runTag}`)
    );
    expect(rows, 'and each event shows once').toHaveLength(seeded.published);
    expect(new Set(rows.map(row => row.id)).size).toBe(seeded.published);
    expect(rejected.result.store.gaps).toHaveLength(1);
    expect(rejected.result.store.gaps[0].before, 'nothing newer arrived, so the gap stays open').toBeUndefined();
    expect((await readCheckpoint(eventsRoot)).cursor).toBe(before.cursor);

    const sources = await run(['custom-log', 'sources', '--target-org', EVENTS_ORG_ALIAS, '--json'], {
      cwd: project.dir
    });
    const listed = sources.json.result.sources.find((source: { id: string }) => source.id === EVENT_SOURCE_ID);
    expect(
      listed.store.gaps.map((gap: { reason: string }) => gap.reason),
      'sources shows the gap too'
    ).toEqual(['cursorRejected']);

    const later = await publishEvents({ count: 3, transactionId: 'rejected', object: EVENT_OBJECTS.replay });
    const closing = await drain(testInfo, project, 'rejected-closing', ['--max-time', '40']);
    expect(closing.result).toMatchObject({ delivered: 3, stored: 3, newGaps: [] });
    expect(closing.result.store.gaps).toHaveLength(1);
    expect(closing.result.store.gaps[0], 'the first stored event newer than `after` closes the gap').toMatchObject({
      reason: 'cursorRejected',
      before: expect.any(String)
    });
    expect(seeded.object).toBe(EVENT_OBJECTS.replay);
    expect(later.published).toBe(3);
  });

  test('a user without Read on the event cannot capture, and core classifies the refusal Salesforce sends', async ({}, testInfo) => {
    const project = await projectFor({ object: EVENT_OBJECTS.log });
    const outcome = await run(
      [...CAPTURE.slice(0, -1), RESTRICTED_ALIAS, '--initial', 'new', '--max-time', '20', '--json'],
      {
        cwd: project.dir
      }
    );
    await attach(testInfo, 'restricted-capture', outcome);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.json).toMatchObject({ name: 'CUSTOM_LOG_SOURCE_UNAVAILABLE' });
    expect(outcome.json.message).toContain('objectNotReadable');

    // `capture` stops at the describe above, so the subscribe refusal is observed through core's own transport.
    const probe = await probeSubscribe(RESTRICTED_ALIAS, EVENT_OBJECTS.log);
    expect(probe).toMatchObject({ outcome: 'failure', failure: { kind: 'forbidden' } });
    expect(probe.failure?.message).toMatch(/^403:denied_by_security_policy:/);
  });

  test('two processes: a drain exits capturedElsewhere, a second --follow stands by and takes over when the holder dies', async ({}, testInfo) => {
    expect(resumed).toBeDefined();
    const { project, eventsRoot } = resumed!;

    const holder = CliProcess.start([...CAPTURE, '--follow'], { cwd: project.dir });
    await holder.waitForStderr(/Catching up from the stored position\./);
    expect((await readLease(eventsRoot))?.pid).toBe(holder.pid);

    const refused = await run([...CAPTURE, '--max-time', '20', '--json'], { cwd: project.dir });
    await attach(testInfo, 'captured-elsewhere', refused);
    expect(refused.json.result).toMatchObject({ outcome: 'capturedElsewhere', delivered: 0, stored: 0 });
    expect(refused.durationMs, 'it returns at once instead of waiting out --max-time').toBeLessThan(15_000);

    const standby = CliProcess.start([...CAPTURE, '--follow'], { cwd: project.dir });
    const waiting = await standby.waitForStderr(/Standing by/);
    expect(waiting.text).toContain(`pid ${holder.pid}`);

    holder.kill();
    const killedAt = Date.now();
    const tookOver = await standby.waitForStderr(/Catching up from the stored position\./);
    const takeoverMs = tookOver.atMs - killedAt;
    console.info(JSON.stringify({ takeoverMs }));
    await testInfo.attach('takeover.json', { body: JSON.stringify({ takeoverMs }), contentType: 'application/json' });
    expect(takeoverMs, 'the standing-by process reclaims a dead holder within a few polls').toBeLessThan(15_000);
    expect((await readLease(eventsRoot))?.pid).toBe(standby.pid);

    const published = await publishEvents({ count: 3, transactionId: 'takeover' });
    await standby.waitForStdoutLines(new RegExp(`\\(${published.runTag}\\)$`), 3);
    standby.interrupt();
    const done = await finish(standby);
    await attach(testInfo, 'takeover', done);
    expect(done.exitCode).toBe(0);
    expect(done.stderr).toMatch(/Delivered 3, stored 3\./);
  });

  test('the concurrent client limit Salesforce reports ends a capture with CUSTOM_LOG_CLIENT_LIMIT', async ({}, testInfo) => {
    const project = await projectFor({ object: EVENT_OBJECTS.log });
    const held = await holdClientsUntilRefused();
    try {
      expect(held.result.refusal?.failureReason).toBe('403::Organization concurrent user limit exceeded');
      const outcome = await run([...CAPTURE, '--initial', 'new', '--max-time', '20', '--json'], {
        cwd: project.dir
      });
      await attach(testInfo, 'client-limit', outcome);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.json).toMatchObject({ name: 'CUSTOM_LOG_CLIENT_LIMIT' });
      expect(outcome.json.message).toContain('concurrent user limit');
    } finally {
      await held.release();
    }
  });
});
