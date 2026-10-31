import { expect, test } from '@playwright/test';
import {
  CliProcess,
  EVENTS_ORG_ALIAS,
  EVENT_OBJECTS,
  EVENT_SOURCE_ID,
  createEventsProject,
  deliveredBy,
  eventsOrgConfigured,
  publishEvents,
  readAllowance
} from '../../utils/eventsOrg';

/**
 * A followed capture holds one CometD long poll after another. Salesforce answers a poll after at most 110 s, so a
 * subscription that is still receiving after that has survived a full poll cycle and the reconnect Faye makes next.
 * Run directly it is the baseline. The proxy lab is the run that puts a corporate proxy in the middle, and it cannot
 * run this yet: its container has the Dev Hub JWT identity and no authorization for `alv-events`, and an alias or a
 * session token is no sanctioned way in (docs/TESTING.md). Faye reads https_proxy and ignores NO_PROXY, which no
 * double exercises.
 *
 * Skips on a machine without the alv-events scratch org, so the pool-only CI is untouched. Spends one delivery.
 */

const POLL_MS = 110_000;
const HOLD_MS = POLL_MS + 20_000;

test.skip(
  !eventsOrgConfigured(),
  'The alv-events scratch org is not authenticated here: node scripts/events-org.mjs ensure.'
);

test('a followed subscription outlives the 110 s long poll and still receives the next event', async ({}, testInfo) => {
  test.setTimeout(HOLD_MS + 5 * 60_000);
  const allowance = await readAllowance();
  test.skip(allowance.remaining < 500, `Only ${allowance.remaining} event deliveries are left today.`);
  const project = await createEventsProject({ object: EVENT_OBJECTS.log });
  try {
    const follow = CliProcess.start(
      [
        'custom-log',
        'capture',
        '--source',
        EVENT_SOURCE_ID,
        '--target-org',
        EVENTS_ORG_ALIAS,
        '--initial',
        'new',
        '--follow'
      ],
      { cwd: project.dir }
    );
    const subscribed = await follow.waitForStderr(/Waiting for new events\./);
    await new Promise(resolve => setTimeout(resolve, HOLD_MS));
    expect(
      follow.stderrLines.map(line => line.text),
      'nothing went wrong while the poll was held'
    ).not.toContainEqual(expect.stringMatching(/^Reconnecting/));

    const publishedAt = Date.now();
    const published = await publishEvents({ count: 1, transactionId: 'poll' });
    const [row] = await follow.waitForStdoutLines(new RegExp(`\\(${published.runTag}\\)$`), 1, 60_000);
    const arrivalMs = row!.atMs - publishedAt;

    follow.interrupt();
    const done = await follow.finished();
    await testInfo.attach('poll.json', {
      body: JSON.stringify(
        {
          heldMs: Date.now() - subscribed.atMs,
          arrivalMs,
          delivered: deliveredBy(done),
          states: follow.stderrLines.map(line => line.text),
          proxy: process.env.HTTPS_PROXY ? 'configured' : 'none'
        },
        null,
        2
      ),
      contentType: 'application/json'
    });
    expect(done.exitCode).toBe(0);
    expect(done.stderr).toMatch(/Delivered 1, stored 1\./);
  } finally {
    await project.cleanup();
  }
});
