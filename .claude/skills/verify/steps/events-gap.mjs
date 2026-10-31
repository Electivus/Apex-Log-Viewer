// Custom Logs event source, gap: stop the capture, move the stored position past anything Salesforce has, start it
// again and watch the strip say that events may be missing. Run `events-capture` first, on the same object.
// The recovery replays `-2`, so it spends one delivery per event the object retains: keep the default replay object.
// args: { object?: 'ALV_Test_Replay__e' }
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_OBJECT, eventsRoot, openEventsPanel, waitForRunToEnd } from './lib/events.mjs';

export default async function ({ h, expect, session, args }) {
  const object = args.object ?? DEFAULT_OBJECT;
  const { logs, strip } = await openEventsPanel({ h, session, expect }, object);

  await logs.getByRole('button', { name: 'Stop' }).click();
  await expect(strip).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

  const root = await eventsRoot(session, object);
  await waitForRunToEnd(root);
  const checkpointFile = path.join(root, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  const [transport, replayId] = checkpoint.cursor.split(':');
  await writeFile(
    checkpointFile,
    JSON.stringify({ ...checkpoint, cursor: `${transport}:${Number(replayId) + 1_000_000}` }, null, 2)
  );

  await logs.getByRole('button', { name: 'Start' }).click();
  const gaps = logs.getByRole('list', { name: 'Possible gaps in the stored events' });
  await expect(gaps).toContainText('may be missing (Salesforce rejected the stored position when capture resumed)', {
    timeout: 120_000
  });
  await expect(strip).toHaveAttribute('data-state', 'live', { timeout: 120_000 });
  const gapLines = await gaps.locator('li').allInnerTexts();
  const gapShot = await h.shot('events-gap', logs);

  const restored = JSON.parse(await readFile(checkpointFile, 'utf8'));
  expect(restored.cursor, 'the replay moved the position back onto the bus').toBe(checkpoint.cursor);
  return { gapLines, stripText: await strip.innerText(), gapShot };
}
