// Custom Logs event source, live: open it, take the first-use choice, publish events and watch the rows and the
// strip. Needs a session started on the events org: `start --target-org alv-events`.
// args: { object?: 'ALV_Test_Replay__e' | 'ALV_Test_Log__e', count?: 5, initial?: 'new' | 'retained' }
//   initial 'retained' replays every event the object still holds, so keep it on the default replay object.
import path from 'node:path';
import { DEFAULT_OBJECT, eventsRoot, openEventsPanel, publishEvents } from './lib/events.mjs';

export default async function ({ h, expect, session, args }) {
  const object = args.object ?? DEFAULT_OBJECT;
  const count = args.count ?? 5;
  const initial = args.initial ?? 'new';
  const { logs, strip } = await openEventsPanel({ h, session, expect }, object);

  await expect(strip).toHaveAttribute('data-state', 'stopped', { timeout: 120_000 });
  await expect(strip).toContainText(
    /daily delivery allocation \(about [\d,]+ of [\d,]+ left\); this run stops after about [\d,]+ deliveries/
  );
  const firstUseText = await strip.innerText();
  const firstUseShot = await h.shot('events-first-use', logs);

  await logs.getByRole('button', { name: initial === 'retained' ? 'Load retained events' : 'Only new events' }).click();
  await expect(strip).toHaveAttribute('data-state', /catchingUp|live/, { timeout: 60_000 });

  const published = await publishEvents(session, { count, object });
  const rows = logs.locator('[data-row-id]').filter({ hasText: `(${published.runTag})` });
  await expect(rows).toHaveCount(count, { timeout: 90_000 });
  const entries = (await rows.allInnerTexts()).map(text => Number(text.match(/entry (\d+) of \d+/)?.[1]));
  expect(entries, 'newest first: the events published last are on top').toEqual(
    Array.from({ length: count }, (_, index) => count - index)
  );

  await expect(strip).toHaveAttribute('data-state', 'live', { timeout: 90_000 });
  const label = strip.getByText('Live', { exact: true });
  await expect(label).toHaveAttribute('title', /Inferred: no event for 10 s/);
  const tooltip = await label.getAttribute('title');
  const liveShot = await h.shot('events-live', logs);

  const store = await eventsRoot(session, object);
  return {
    firstUseText,
    firstUseShot,
    runTag: published.runTag,
    entries,
    stripText: await strip.innerText(),
    tooltip,
    liveShot,
    store: path.basename(store)
  };
}
