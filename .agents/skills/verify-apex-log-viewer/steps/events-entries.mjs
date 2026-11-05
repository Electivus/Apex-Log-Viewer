// Custom Logs event source whose long text fields hold JSON arrays: each item reads as its own entry row, with the
// roles taken from payload paths. Needs a session started on the events org: `start --target-org alv-events`, and a
// workspace that never stored a position for the object, so run it once per `start`.
// args: { object?: 'ALV_Test_Log__e', count?: 2, payloadEntries?: 2, initial?: 'new' | 'retained' }
//   Each event yields payloadEntries message items, one metric item and one Stack_Trace__c item.
import { hasStoredPosition, openEventsPanel, publishEvents } from './lib/events.mjs';

const ROW_ID = /^e-[0-9a-z]{9}-[0-9a-z]{10}-[0-9a-f]{32}(?:-(?!0000)[0-9a-z]{4})?$/;
const PLAIN_ID_LENGTH = 55;

export default async function ({ h, expect, session, args }) {
  const object = args.object ?? 'ALV_Test_Log__e';
  const count = args.count ?? 2;
  const payloadEntries = args.payloadEntries ?? 2;
  const initial = args.initial ?? 'new';
  if (await hasStoredPosition(session, object)) {
    throw new Error(
      `This session already stored a position for ${object}, so the panel resumes instead of asking the first-use question. Run stop and start for a fresh workspace.`
    );
  }
  const mapping = {
    object,
    fields: {
      time: { path: 'timestamp' },
      message: { path: 'msg' },
      level: { path: 'level' },
      user: { path: 'username' },
      transactionId: { path: 'traceId' },
      origin: { path: 'caller' },
      requestId: 'Request_Id__c'
    },
    payload: { entries: ['Payload__c', 'Stack_Trace__c'], columns: ['traceId', 'level', 'msg'] }
  };
  const { logs, strip } = await openEventsPanel({ h, session, expect }, object, mapping);

  await expect(strip).toHaveAttribute('data-state', 'stopped', { timeout: 120_000 });
  await logs.getByRole('button', { name: initial === 'retained' ? 'Load retained events' : 'Only new events' }).click();
  await expect(strip).toHaveAttribute('data-state', /catchingUp|live/, { timeout: 60_000 });

  // The metric item has no msg: only its JSON text carries the run tag, as the transaction id, without parentheses.
  const { runTag } = await publishEvents(session, { count, object, payloadEntries });
  const rows = logs.locator('[data-row-id]').filter({ hasText: runTag });
  const expected = count * (payloadEntries + 2);
  await expect(rows, 'every array item is its own row').toHaveCount(expected, { timeout: 90_000 });

  const ids = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-row-id')));
  for (const id of ids) expect(id, `row id ${id} has the entry id shape`).toMatch(ROW_ID);
  const plain = ids.filter(id => id.length === PLAIN_ID_LENGTH);
  expect(plain.length, 'one plain id per event, the other items carry a 4-character suffix').toBe(count);
  expect(new Set(ids.map(id => id.slice(0, PLAIN_ID_LENGTH))).size, 'the suffixed ids share their event id').toBe(
    count
  );
  for (const id of ids.filter(id => id.length !== PLAIN_ID_LENGTH)) {
    expect(id.length, `suffixed id ${id}`).toBe(PLAIN_ID_LENGTH + 5);
  }

  const titles = await rows.evaluateAll(nodes =>
    nodes.map(node => node.querySelector('[title]')?.getAttribute('title') ?? node.textContent ?? '')
  );
  expect(
    titles.filter(title => title.includes(`Execution resume (${runTag})`)).length,
    'one Stack_Trace__c item per event'
  ).toBe(count);
  expect(
    titles.filter(title => /Synthetic \w+ entry 1 of \d+/.test(title)).length,
    'the first message item of each event'
  ).toBe(count);
  expect(
    titles.filter(title => title.includes('"type":"metric"')).length,
    'the metric item has no msg, so its title is its JSON text'
  ).toBe(count);

  const resumeRows = rows.filter({ hasText: `Execution resume (${runTag})` });
  await expect(resumeRows).toHaveCount(count);
  for (const row of await resumeRows.all()) {
    await expect(row, 'the Stack_Trace__c item reads its level from its own path').toContainText('INFO');
  }

  const rowsShot = await h.shot('events-entries-rows', logs);
  return { runTag, ids, titles, rowsShot };
}
