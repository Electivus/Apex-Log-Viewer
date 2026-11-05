// Custom Logs event source, gap: stop the capture, move the stored position past anything Salesforce has, start it
// again and watch the strip say that events may be missing. Run `events-capture` first, on the same object.
// The recovery replays `-2`, so it spends one delivery per event the object retains: keep the default replay object.
// A rejected cursor reuses a gap that is still open, so a gap an earlier run left open is closed first by publishing
// one event; the step then requires a gap of its own, on disk and on screen. `events-gap-control` checks that.
// args: { object?: 'ALV_Test_Replay__e' }
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_OBJECT,
  eventsRoot,
  openEventsPanel,
  openGaps,
  publishEvents,
  readGaps,
  waitForRunToEnd
} from './lib/events.mjs';

export default async function ({ h, expect, session, args }) {
  const object = args.object ?? DEFAULT_OBJECT;
  const { logs, strip } = await openEventsPanel({ h, session, expect }, object);
  const root = await eventsRoot(session, object);

  // The panel does not resume a capture the user stopped, and closing a gap needs a running one.
  const start = logs.getByRole('button', { name: 'Start' });
  if (await start.count()) await start.click();
  await expect(strip).toHaveAttribute('data-state', 'live', { timeout: 120_000 });

  const leftOpen = (await openGaps(root)).map(gap => gap.id);
  if (leftOpen.length > 0) {
    await publishEvents(session, { count: 1, object, transactionId: 'verify-gap' });
    await expect
      .poll(async () => (await openGaps(root)).length, {
        timeout: 90_000,
        message: 'the event published to close the open gap was stored'
      })
      .toBe(0);
  }
  const gapsBefore = await readGaps(root);
  const gaps = logs.getByRole('list', { name: 'Possible gaps in the stored events' });
  await expect(gaps.locator('li'), 'the strip shows every stored gap').toHaveCount(gapsBefore.size, {
    timeout: 30_000
  });

  await logs.getByRole('button', { name: 'Stop' }).click();
  await expect(strip).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

  await waitForRunToEnd(root);
  const checkpointFile = path.join(root, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  const [transport, replayId] = checkpoint.cursor.split(':');
  await writeFile(
    checkpointFile,
    JSON.stringify({ ...checkpoint, cursor: `${transport}:${Number(replayId) + 1_000_000}` }, null, 2)
  );

  await logs.getByRole('button', { name: 'Start' }).click();
  await expect
    .poll(
      async () => [...(await readGaps(root)).values()].filter(gap => !gapsBefore.has(gap.id)).map(gap => gap.reason),
      { timeout: 120_000, message: 'this Start wrote a gap of its own' }
    )
    .toEqual(['cursorRejected']);
  await expect(gaps.locator('li'), 'the strip shows the new gap').toHaveCount(gapsBefore.size + 1, {
    timeout: 30_000
  });
  await expect(gaps).toContainText('may be missing (Salesforce rejected the stored position when capture resumed)');
  await expect(strip).toHaveAttribute('data-state', 'live', { timeout: 120_000 });
  const gapLines = await gaps.locator('li').allInnerTexts();
  const gapShot = await h.shot('events-gap', logs);

  const restored = JSON.parse(await readFile(checkpointFile, 'utf8'));
  expect(restored.cursor, 'the replay moved the position back onto the bus').toBe(checkpoint.cursor);
  return { closedGaps: leftOpen, gapLines, stripText: await strip.innerText(), gapShot };
}
