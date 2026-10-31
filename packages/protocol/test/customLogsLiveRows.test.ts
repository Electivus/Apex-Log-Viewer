import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeLiveRows } from '../src/customLogsTypes.ts';

const BASE_MS = 1_790_000_000_000;

/** An event id in core's encoding: event time, capture sequence, uuid. Later arguments sort later in time. */
function eventId(offsetMs: number, seq = 0, uuidTail = 0): string {
  return [
    'e',
    (BASE_MS + offsetMs).toString(36).padStart(9, '0'),
    seq.toString(36).padStart(10, '0'),
    uuidTail.toString(16).padStart(32, '0')
  ].join('-');
}

function rowAt(offsetMs: number, seq = 0, uuidTail = 0) {
  return { id: eventId(offsetMs, seq, uuidTail), offsetMs };
}

const idsOf = (rows: readonly { id: string }[]) => rows.map(row => row.id);
const newestFirst = (rows: readonly { id: string }[]) => [...rows].sort((a, b) => (a.id < b.id ? 1 : -1));

/** A fixed pseudo-random sequence, so a failing case is the same case on every run. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

test('live rows land above the loaded rows when they are newer, in the order the store lists them', () => {
  const loaded = [rowAt(30), rowAt(20), rowAt(10)];
  const incoming = [rowAt(50), rowAt(40)];

  assert.deepEqual(idsOf(mergeLiveRows(loaded, incoming, { hasMore: false })), idsOf([...incoming, ...loaded]));
});

test('rows stored in the same millisecond keep the capture order, newest sequence first', () => {
  const loaded = [rowAt(10, 2), rowAt(10, 0)];
  const incoming = [rowAt(10, 3), rowAt(10, 1)];

  assert.deepEqual(
    idsOf(mergeLiveRows(loaded, incoming, { hasMore: false })),
    idsOf([rowAt(10, 3), rowAt(10, 2), rowAt(10, 1), rowAt(10, 0)])
  );
});

test('a late row slots in between loaded rows, wherever its event time puts it', () => {
  const loaded = [rowAt(30), rowAt(20), rowAt(10)];

  assert.deepEqual(
    idsOf(mergeLiveRows(loaded, [rowAt(25), rowAt(15)], { hasMore: true })),
    idsOf([rowAt(30), rowAt(25), rowAt(20), rowAt(15), rowAt(10)])
  );
});

test('the order of an incoming batch does not matter', () => {
  const loaded = [rowAt(30), rowAt(10)];
  const incoming = [rowAt(50), rowAt(20), rowAt(40)];

  assert.deepEqual(
    idsOf(mergeLiveRows(loaded, incoming, { hasMore: false })),
    idsOf(mergeLiveRows(loaded, [...incoming].reverse(), { hasMore: false }))
  );
  assert.deepEqual(
    idsOf(mergeLiveRows(loaded, incoming, { hasMore: false })),
    idsOf([rowAt(50), rowAt(40), rowAt(30), rowAt(20), rowAt(10)])
  );
});

test('a row that is already loaded stays the loaded one, and a repeat inside the batch counts once', () => {
  const loaded = [rowAt(30), rowAt(20)];
  const sameAsLoaded = { ...loaded[1]!, offsetMs: -1 };
  const fresh = rowAt(40);

  const merged = mergeLiveRows(loaded, [fresh, sameAsLoaded, fresh, sameAsLoaded], { hasMore: false });

  assert.deepEqual(idsOf(merged), idsOf([fresh, ...loaded]));
  assert.equal(merged[2], loaded[1]);
});

test('a batch that is already loaded changes nothing', () => {
  const loaded = [rowAt(30), rowAt(20), rowAt(10)];

  for (const hasMore of [true, false]) {
    assert.deepEqual(mergeLiveRows(loaded, [...loaded].reverse(), { hasMore }), loaded);
    assert.deepEqual(mergeLiveRows(loaded, [], { hasMore }), loaded);
  }
});

test('while more pages follow, a row older than the last loaded one waits for that page', () => {
  const loaded = [rowAt(30), rowAt(20)];
  const older = rowAt(10);

  assert.deepEqual(mergeLiveRows(loaded, [older, rowAt(40)], { hasMore: true }), [rowAt(40), ...loaded]);
});

test('once the last page is loaded, a row older than every loaded row goes to the end', () => {
  const loaded = [rowAt(30), rowAt(20)];
  const older = [rowAt(10), rowAt(5)];

  assert.deepEqual(idsOf(mergeLiveRows(loaded, older, { hasMore: false })), idsOf([...loaded, ...older]));
});

test('an empty list takes every incoming row, because there is no next page to protect', () => {
  const incoming = [rowAt(10), rowAt(30), rowAt(20)];

  for (const hasMore of [true, false]) {
    assert.deepEqual(idsOf(mergeLiveRows([], incoming, { hasMore })), idsOf(newestFirst(incoming)));
  }
});

test('the merge matches sorting everything newest first, for any split of a shuffled set', () => {
  const random = sequence(20_261_031);
  for (let round = 0; round < 200; round++) {
    const universe = Array.from({ length: 1 + Math.floor(random() * 30) }, () =>
      rowAt(Math.floor(random() * 6), Math.floor(random() * 3), Math.floor(random() * 4))
    );
    const unique = newestFirst([...new Map(universe.map(row => [row.id, row])).values()]);
    const loaded = unique.filter(() => random() < 0.5);
    const incoming = [...universe.filter(row => !loaded.includes(row))].sort(() => random() - 0.5);
    const floor = loaded.at(-1)?.id;

    assert.deepEqual(
      idsOf(mergeLiveRows(loaded, incoming, { hasMore: false })),
      idsOf(unique),
      `round ${round} without more pages`
    );
    assert.deepEqual(
      idsOf(mergeLiveRows(loaded, incoming, { hasMore: true })),
      idsOf(unique.filter(row => loaded.includes(row) || floor === undefined || row.id > floor)),
      `round ${round} with more pages`
    );
  }
});

test('the merge never changes the lists it was given', () => {
  const loaded = [rowAt(30), rowAt(10)];
  const incoming = [rowAt(20), rowAt(40)];
  const snapshot = structuredClone({ loaded, incoming });

  mergeLiveRows(loaded, incoming, { hasMore: false });

  assert.deepEqual({ loaded, incoming }, snapshot);
});
