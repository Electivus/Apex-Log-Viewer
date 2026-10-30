import assert from 'node:assert/strict';

import { parseCustomLogLevel, parseSinceValue } from '@alv/protocol/customLogsRules';
import { CUSTOM_LOG_LEVELS } from '@alv/protocol/customLogsTypes';

import { coreContracts, coreLevels, coreSince } from '../coreInternals';

const NOW = Date.parse('2026-10-30T12:00:00Z');

function coreAcceptsSince(value: string): boolean {
  try {
    coreSince.parseSinceExpression(value, new Date(NOW));
    return true;
  } catch {
    return false;
  }
}

suite('Custom Logs rules agree between core and protocol', () => {
  suite('since', () => {
    const table = [
      '30m',
      '24h',
      '7d',
      ' 24h ',
      '999999999m',
      '999999999d',
      '1000000000h',
      '0h',
      '24',
      '1.5h',
      'yesterday',
      '',
      '2026-10-29',
      '2026-10-29T10:00',
      '2026-10-29T10:00:00',
      '2026-10-29T10:00Z',
      '2026-10-29T10:00:00Z',
      '2026-10-29T10:00:00.123456789Z',
      '2026-10-29T10:00:00.1234567890Z',
      '2026-10-29T10:00:00+03:00',
      '2026-10-29T10:00:00-0300',
      '2026-10-29T10:00:00+3',
      '2026-13-45',
      '2026-02-30',
      '2026-10-29T25:00:00Z',
      'x'.repeat(65)
    ];

    for (const value of table) {
      test(`gives the same verdict as core for ${JSON.stringify(value)}`, () => {
        assert.equal(parseSinceValue(value, NOW) !== undefined, coreAcceptsSince(value));
      });
    }
  });

  suite('levels', () => {
    test('lists the levels in the same order, which sorting and minimum-level filtering depend on', () => {
      assert.deepEqual([...CUSTOM_LOG_LEVELS], [...coreContracts.CUSTOM_LOG_LEVELS]);
    });

    for (const value of ['WARN', 'warn', 'Warn', 'WARNING', 'TRACE', ' WARN', '', 'verbose', 3, null, undefined]) {
      test(`parses ${JSON.stringify(value)} like core`, () => {
        assert.equal(parseCustomLogLevel(value), coreLevels.parseCustomLogLevel(value));
      });
    }
  });
});
