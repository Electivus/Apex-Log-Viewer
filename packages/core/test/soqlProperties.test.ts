import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError } from '../src/errors.ts';
import {
  escapeSoqlLikeLiteral,
  escapeSoqlLiteral,
  normalizeSoqlDateTimeLiteral,
  soqlNumberLiteral
} from '../src/soql.ts';
import { fc, returnsOrFailsWith } from './support/properties.ts';

/** The escapes of a SOQL string literal (`\%` and `\_` only mean something inside LIKE). */
const UNESCAPE: Readonly<Record<string, string>> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  '%': '%',
  _: '_'
};

/**
 * Reads the body of `'…'` as SOQL does. Undefined when the body would end the literal early, use an
 * escape SOQL does not know or, for LIKE, hold a bare wildcard that matches more than its own text.
 */
function readSoqlLiteral(body: string, like: boolean): string | undefined {
  let text = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "'" || (like && (char === '%' || char === '_'))) return undefined;
    if (char !== '\\') {
      text += char;
      continue;
    }
    const escaped = UNESCAPE[body[++index] ?? ''];
    if (escaped === undefined) return undefined;
    text += escaped;
  }
  return text;
}

/** C0 controls SOQL has a spelling for; any other one cannot appear in a literal. */
const SPELLABLE_CONTROLS = new Set(['\n', '\r', '\t', '\b', '\f']);
const hasUnspellableControl = (text: string): boolean =>
  [...text].some(char => char < ' ' && !SPELLABLE_CONTROLS.has(char));

const soqlText = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: fc.constantFrom('\\', "'", '"', '%', '_', '\n', '\r', '\t', '\b', '\f', 'a', ' ', 'é', '\u0000') })
);

test('a SOQL literal reads back as the text it was built from, or the text is refused', () => {
  for (const [escape, like] of [
    [escapeSoqlLiteral, false],
    [escapeSoqlLikeLiteral, true]
  ] as const) {
    fc.assert(
      fc.property(soqlText, text => {
        const body = returnsOrFailsWith('INVALID_ARGUMENT', () => escape(text));
        if (body instanceof AlvError) assert.ok(hasUnspellableControl(text), JSON.stringify(text));
        else assert.equal(readSoqlLiteral(body, like), text);
      })
    );
  }
});

test('a SOQL number literal has no exponent and reads back as the same number', () => {
  fc.assert(
    fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), value => {
      const literal = soqlNumberLiteral(value);
      assert.match(literal, /^-?\d+(\.\d+)?$/);
      assert.ok(Number(literal) === value, `${literal} reads back as ${value}, signed zeros alike`);
      if (Number.isInteger(value) && Math.abs(value) > 2_147_483_647) assert.match(literal, /\.0$/);
    })
  );
  fc.assert(
    fc.property(fc.constantFrom(Number.NaN, Infinity, -Infinity), value => {
      assert.throws(
        () => soqlNumberLiteral(value),
        (error: unknown) => error instanceof AlvError
      );
    }),
    { numRuns: 3 }
  );
});

test('a normalized SOQL datetime names the same instant and normalizes to itself', () => {
  const dateText = fc.oneof(
    fc.date({ noInvalidDate: true }).map(date => date.toISOString()),
    fc.date({ noInvalidDate: true }).map(date => ` ${date.toUTCString()}\t`),
    fc.string()
  );
  fc.assert(
    fc.property(fc.oneof(dateText, fc.anything()), value => {
      const normalized = normalizeSoqlDateTimeLiteral(value);
      if (normalized === undefined) return;
      assert.equal(Date.parse(normalized), Date.parse((value as string).trim()));
      assert.equal(normalizeSoqlDateTimeLiteral(normalized), normalized);
    })
  );
});
