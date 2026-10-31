import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_LOG_EVENT_ID_PATTERN } from '../src/customLogs/contracts.ts';
import {
  SEQ_LIMIT,
  cometdCursor,
  compareNewestFirst,
  eventRowId,
  isCaptureSeq,
  parseEventRowId,
  parseEventUuid,
  readCursor,
  type CaptureSeq,
  type EventPosition
} from '../src/customLogs/events/ids.ts';

const CREATED_MS_LIMIT = 36 ** 9;
const uuid = (text: string) => parseEventUuid(text)!;
const position = (createdMs: number, seq: number, id: string): EventPosition => ({
  createdMs,
  seq: seq as CaptureSeq,
  uuid: uuid(id)
});

const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ZERO = '00000000-0000-4000-8000-000000000000';

/** A small deterministic generator, so the order property runs the same everywhere. */
function pseudoRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function hexUuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function samplePositions(count: number): EventPosition[] {
  const random = pseudoRandom(7);
  const edges = [
    position(0, 0, ZERO),
    position(CREATED_MS_LIMIT - 1, SEQ_LIMIT - 1, B),
    position(1793321290000, 0, A),
    position(1793321290000, 1, A),
    position(1793321290000, 1, B),
    position(1793321290001, 0, ZERO)
  ];
  const generated = Array.from({ length: count }, () =>
    position(
      random() < 0.5 ? 1793321290000 + Math.floor(random() * 3) : Math.floor(random() * CREATED_MS_LIMIT),
      random() < 0.5 ? Math.floor(random() * 4) : Math.floor(random() * SEQ_LIMIT),
      hexUuid(random)
    )
  );
  return [...edges, ...generated];
}

const ascending = (a: EventPosition, b: EventPosition) => compareNewestFirst(b, a);
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

test('an event id round-trips its position and is 55 characters of the contract pattern', () => {
  for (const sample of samplePositions(200)) {
    const id = eventRowId(sample);
    assert.equal(id.length, 55);
    assert.match(id, CUSTOM_LOG_EVENT_ID_PATTERN);
    assert.deepEqual(parseEventRowId(id), sample);
  }
});

test('event ids compare as strings in list order, whatever the time, sequence and uuid', () => {
  const samples = samplePositions(200);

  const byId = [...samples].sort((a, b) => compareStrings(eventRowId(a), eventRowId(b)));
  const byPosition = [...samples].sort(ascending);

  assert.deepEqual(byId, byPosition);
  const newestFirst = [...samples].sort(compareNewestFirst).map(eventRowId);
  assert.deepEqual(newestFirst, [...newestFirst].sort().reverse());
});

test('the time decides first, then the capture sequence, then the uuid', () => {
  const ordered = [
    position(1000, 9, B),
    position(1001, 0, ZERO),
    position(1001, 1, ZERO),
    position(1001, 1, A),
    position(1001, 1, B)
  ].map(eventRowId);

  assert.deepEqual([...ordered].sort(), ordered);
});

test('an event id carries the position and nothing else, in particular no replay value', () => {
  const parsed = parseEventRowId(eventRowId(position(1793321290000, 5, A)));

  assert.deepEqual(Object.keys(parsed!).sort(), ['createdMs', 'seq', 'uuid']);
});

test('only an exact event id parses: record ids, other cases and other lengths are not event ids', () => {
  const valid = eventRowId(position(1793321290000, 5, A));
  const rejected = [
    'a015g00000Q2xYz',
    'a015g00000Q2xYzAAB',
    '',
    valid.slice(1),
    valid.slice(0, -1),
    `${valid}0`,
    valid.replace(/^e-/, 'E-'),
    valid.toUpperCase(),
    valid.replace(/-[0-9a-f]{32}$/, `-${'G'.repeat(32)}`),
    valid.replace(/^e-/, 'x-'),
    ` ${valid}`,
    `${valid}\n`,
    null,
    undefined,
    42,
    {}
  ];

  for (const value of rejected) {
    assert.equal(parseEventRowId(value), undefined, JSON.stringify(value));
    if (typeof value === 'string') assert.equal(CUSTOM_LOG_EVENT_ID_PATTERN.test(value), false, JSON.stringify(value));
  }
  assert.notEqual(parseEventRowId(valid), undefined);
});

test('an event time that does not fit nine base36 digits has no id', () => {
  for (const createdMs of [-1, 1.5, Number.NaN, CREATED_MS_LIMIT, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => eventRowId(position(createdMs, 0, A)), RangeError, String(createdMs));
  }
  assert.equal(eventRowId(position(CREATED_MS_LIMIT - 1, 0, A)).slice(2, 11), 'zzzzzzzzz');
});

test('an event uuid is parsed once: any case in, lower case out, anything else refused', () => {
  assert.equal(parseEventUuid(A.toUpperCase()), A);
  assert.equal(parseEventUuid(A), A);
  for (const value of ['', 'not-a-uuid', A.replace(/-/g, ''), `${A}0`, ` ${A}`, `{${A}}`, null, 7]) {
    assert.equal(parseEventUuid(value), undefined, JSON.stringify(value));
  }
});

test('a capture sequence is a non-negative safe integer below 36^10', () => {
  for (const value of [0, 1, SEQ_LIMIT - 1]) assert.equal(isCaptureSeq(value), true, String(value));
  for (const value of [-1, 0.5, SEQ_LIMIT, Number.MAX_SAFE_INTEGER, Number.NaN, '1', null]) {
    assert.equal(isCaptureSeq(value), false, String(value));
  }
});

test('a CometD cursor keeps its transport tag, and only a non-negative safe integer makes one', () => {
  const cursor = cometdCursor(15253040);

  assert.deepEqual(readCursor(cursor), { transport: 'cometd', value: '15253040' });
  assert.equal(cometdCursor(0), 'cometd:0');
  for (const replayId of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(() => cometdCursor(replayId), RangeError, String(replayId));
  }
  assert.throws(() => readCursor('kafka:1' as ReturnType<typeof cometdCursor>), /Unknown replay cursor transport/);
});

test('the newest-first order is the reverse of the id order for uuids that differ', () => {
  const older = position(1000, 0, A);
  const newer = position(1000, 0, B);

  assert.ok(compareNewestFirst(older, newer) > 0);
  assert.ok(compareNewestFirst(newer, older) < 0);
  assert.equal(compareNewestFirst(older, { ...older }), 0);
});
