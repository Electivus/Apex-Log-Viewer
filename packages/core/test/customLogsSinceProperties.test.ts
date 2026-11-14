import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError } from '../src/errors.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../src/customLogs/queries.ts';
import { parseSinceExpression } from '../src/customLogs/since.ts';
import { fc, returnsOrFailsWith } from './support/properties.ts';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const LAST_DATE_MS = 8.64e15;

const now = fc.date({ noInvalidDate: true });
const blank = fc.constantFrom('', ' ', '\t', '\n', ' \r\n ');
const pad = (width: number) => (value: number) => String(value).padStart(width, '0');

/** The Gregorian calendar, written out so the test does not lean on `Date` to say which days exist. */
function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** An ISO-8601 instant as a person types it: any precision, `Z` or an offset with or without its colon. */
const isoText = fc
  .record({
    year: fc.integer({ min: 0, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
    time: fc.option(
      fc.record({
        hour: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
        second: fc.option(fc.integer({ min: 0, max: 59 })),
        fraction: fc.option(fc.stringMatching(/^\d{1,9}$/)),
        offsetMinutes: fc.integer({ min: -(23 * 60 + 59), max: 23 * 60 + 59 }),
        zulu: fc.boolean(),
        colon: fc.boolean()
      })
    )
  })
  .map(fields => {
    const { year, month, day, time } = fields;
    const date = `${pad(4)(year)}-${pad(2)(month)}-${pad(2)(day)}`;
    if (!time) return { fields, offsetMinutes: 0, millis: 0, text: date };
    const { hour, minute, second, fraction, zulu, colon } = time;
    const offsetMinutes = zulu ? 0 : time.offsetMinutes;
    const seconds = second === null ? '' : `:${pad(2)(second)}${fraction === null ? '' : `.${fraction}`}`;
    const abs = Math.abs(offsetMinutes);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const offset = zulu ? 'Z' : `${sign}${pad(2)(Math.floor(abs / 60))}${colon ? ':' : ''}${pad(2)(abs % 60)}`;
    const millis = second === null || fraction === null ? 0 : Number(fraction.padEnd(3, '0').slice(0, 3));
    return { fields, offsetMinutes, millis, text: `${date}T${pad(2)(hour)}:${pad(2)(minute)}${seconds}${offset}` };
  });

const binding: CursorBinding = {
  o: '00D000000000001AAA',
  s: 'nebula',
  m: 'abcdef012345',
  k: 'list',
  f: '0123456789ab'
};

test('any --since text resolves to an instant the next page accepts, or fails as INVALID_ARGUMENT', () => {
  const sinceText = fc.oneof(
    fc.string(),
    fc.tuple(fc.integer(), fc.constantFrom('m', 'h', 'd', 's', '')).map(([count, unit]) => `${count}${unit}`),
    isoText.map(iso => iso.text),
    fc.tuple(blank, fc.string({ unit: fc.constantFrom(...'0123456789-:.TZ+ ') }), blank).map(parts => parts.join(''))
  );
  fc.assert(
    fc.property(sinceText, now, (text, at) => {
      const since = returnsOrFailsWith('INVALID_ARGUMENT', () => parseSinceExpression(text, at));
      if (since instanceof AlvError) return;
      const cursor = { v: 1 as const, ...binding, w: { since }, t: since, id: 'a02000000000002AAA' };
      assert.deepEqual(decodeCursor(encodeCursor(cursor), binding), cursor);
    })
  );
});

test('a duration counts back from now, or fails when that instant is past the calendar', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 999_999_999 }),
      fc.constantFrom(...(Object.keys(UNIT_MS) as (keyof typeof UNIT_MS)[])),
      now,
      blank,
      (count, unit, at, padding) => {
        const instant = at.getTime() - count * UNIT_MS[unit];
        const since = returnsOrFailsWith('INVALID_ARGUMENT', () =>
          parseSinceExpression(`${padding}${count}${unit}${padding}`, at)
        );
        if (Math.abs(instant) > LAST_DATE_MS)
          assert.ok(since instanceof AlvError, `${count}${unit} before ${at.toISOString()}`);
        else assert.equal(since, new Date(instant).toISOString());
      }
    )
  );
});

test('an ISO instant resolves to the date and time it spells at its offset, or fails when that day does not exist', () => {
  fc.assert(
    fc.property(isoText, blank, ({ fields, offsetMinutes, millis, text }, padding) => {
      const { year, month, day, time } = fields;
      const since = returnsOrFailsWith('INVALID_ARGUMENT', () =>
        parseSinceExpression(`${padding}${text}${padding}`, new Date(0))
      );
      if (day > daysIn(year, month)) {
        assert.ok(since instanceof AlvError, `${text} names a day ${pad(4)(year)}-${pad(2)(month)} does not have`);
        return;
      }
      const spelled = new Date(0);
      spelled.setUTCFullYear(year, month - 1, day);
      spelled.setUTCHours(time?.hour ?? 0, time?.minute ?? 0, time?.second ?? 0, millis);
      assert.equal(since, new Date(spelled.getTime() - offsetMinutes * 60_000).toISOString(), text);
    })
  );
});
