import assert from 'node:assert/strict';
import test from 'node:test';

import { AlvError } from '../src/index.ts';
import { escapeSoqlLikeLiteral, escapeSoqlLiteral, isSalesforceId, normalizeSoqlDateTimeLiteral } from '../src/soql.ts';

test('escapeSoqlLiteral spells every character a SOQL string literal can escape', () => {
  assert.equal(escapeSoqlLiteral('plain text 100%_'), 'plain text 100%_');
  assert.equal(escapeSoqlLiteral("O'Brien"), "O\\'Brien");
  assert.equal(escapeSoqlLiteral('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeSoqlLiteral('back\\slash'), 'back\\\\slash');
  assert.equal(escapeSoqlLiteral('a\nb\rc\td\be\ff'), 'a\\nb\\rc\\td\\be\\ff');
  assert.equal(escapeSoqlLiteral("\\'"), "\\\\\\'");
  assert.equal(escapeSoqlLiteral(''), '');
});

test('escapeSoqlLiteral rejects control characters SOQL cannot spell', () => {
  for (const code of [0x00, 0x01, 0x07, 0x0b, 0x0e, 0x1b, 0x1f]) {
    assert.throws(
      () => escapeSoqlLiteral(`a${String.fromCharCode(code)}b`),
      (error: unknown) =>
        error instanceof AlvError &&
        error.code === 'INVALID_ARGUMENT' &&
        error.message.includes(`U+${code.toString(16).padStart(4, '0').toUpperCase()}`),
      `U+${code.toString(16)}`
    );
  }
  assert.equal(escapeSoqlLiteral('del\u007fete'), 'del\u007fete');
});

test('escapeSoqlLikeLiteral also escapes the LIKE wildcards', () => {
  assert.equal(escapeSoqlLikeLiteral("50%_off\\'\n"), "50\\%\\_off\\\\\\'\\n");
  assert.throws(() => escapeSoqlLikeLiteral('a\u0000'), AlvError);
});

test('isSalesforceId accepts 15 and 18 character ids only', () => {
  assert.equal(isSalesforceId('005000000000001'), true);
  assert.equal(isSalesforceId('005000000000001AAA'), true);
  assert.equal(isSalesforceId('00500000000000'), false);
  assert.equal(isSalesforceId('0050000000000012'), false);
  assert.equal(isSalesforceId('00500000000000123'), false);
  assert.equal(isSalesforceId('005000000000001AAAA'), false);
  assert.equal(isSalesforceId("005000000000001'OR'"), false);
  assert.equal(isSalesforceId(undefined), false);
});

test('normalizeSoqlDateTimeLiteral returns an ISO instant or undefined', () => {
  assert.equal(normalizeSoqlDateTimeLiteral('2026-10-14T09:00:00.000+0000'), '2026-10-14T09:00:00.000Z');
  assert.equal(normalizeSoqlDateTimeLiteral('  2026-10-14T09:00:00Z '), '2026-10-14T09:00:00.000Z');
  assert.equal(normalizeSoqlDateTimeLiteral('not a date'), undefined);
  assert.equal(normalizeSoqlDateTimeLiteral(''), undefined);
  assert.equal(normalizeSoqlDateTimeLiteral(42), undefined);
});
