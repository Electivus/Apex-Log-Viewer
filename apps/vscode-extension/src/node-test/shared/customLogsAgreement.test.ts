import assert from 'node:assert/strict';

import { parseCustomLogsFromWebviewMessage } from '@alv/protocol/customLogsMessages';
import { parseCustomLogLevel, parseSinceValue } from '@alv/protocol/customLogsRules';
import {
  CUSTOM_LOG_LEVELS,
  mergePayloadFields,
  parseCustomLogRecordId,
  type CustomLogPayloadField,
  type CustomLogPayloadType,
  type CustomLogPayloadView
} from '@alv/protocol/customLogsTypes';

import { coreConfig, coreContracts, coreLevels, corePayload, coreSince, coreSoql } from '../coreInternals';

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

  suite('ids', () => {
    const recordIds = [
      'a015g00000Q2xYz',
      'a015g00000Q2xYzAAB',
      'a015g00000Q2xY',
      'a015g00000Q2xYzA',
      'a015g00000Q2xYzAA',
      'a015g00000Q2xYzAABX',
      "a015g00000Q2xYz'",
      'a015g00000Q2x-zAAB',
      ''
    ];

    for (const id of recordIds) {
      test(`treats the record id ${JSON.stringify(id)} like core`, () => {
        assert.equal(parseCustomLogRecordId(id) !== undefined, coreSoql.isSalesforceId(id));
      });
    }

    const sourceIds = ['nebula', 'app-log', 'a', 'Nebula', '1app', 'app_log', 'a'.repeat(40), 'a'.repeat(41), ''];

    for (const id of sourceIds) {
      test(`treats the source id ${JSON.stringify(id)} like core`, () => {
        const coreRejects = coreConfig
          .parseSourceDefinition({ id }, '/source')
          .issues.some(issue => issue.pointer === '/source/id');
        const protocolAccepts =
          parseCustomLogsFromWebviewMessage({ type: 'customLogsSelectSource', sourceId: id }) !== undefined;
        assert.equal(protocolAccepts, !coreRejects);
      });
    }
  });

  suite('payload field summaries', () => {
    const TYPES: Record<CustomLogPayloadType, CustomLogPayloadView> = {
      string: { state: 'parsed', values: { a: 'text' }, droppedPaths: 0, cutValues: [] },
      number: { state: 'parsed', values: { a: 1 }, droppedPaths: 0, cutValues: [] },
      boolean: { state: 'parsed', values: { a: true }, droppedPaths: 0, cutValues: [] },
      null: { state: 'parsed', values: { a: null }, droppedPaths: 0, cutValues: [] }
    };
    const NAMES = Object.keys(TYPES) as CustomLogPayloadType[];

    function pages(order: readonly CustomLogPayloadType[]): CustomLogPayloadField[][] {
      return order.map(type => corePayload.summarizePayloadFields([TYPES[type]]));
    }

    test('merges the types of every page in the order core lists them, whichever page came first', () => {
      const orders = NAMES.flatMap(first => NAMES.filter(second => second !== first).map(second => [first, second]));
      for (const order of orders) {
        const [loaded, page] = pages(order);
        const expected = corePayload.summarizePayloadFields(order.map(type => TYPES[type!]!));
        assert.deepEqual(mergePayloadFields(loaded!, page!), expected, `pages ${order.join(' then ')}`);
      }
    });

    test('merges four pages into the same order as one core summary over all their rows', () => {
      const reversed = [...NAMES].reverse();
      const merged = pages(reversed).reduce<CustomLogPayloadField[]>(
        (loaded, page) => mergePayloadFields(loaded, page),
        []
      );
      assert.deepEqual(merged, corePayload.summarizePayloadFields(reversed.map(type => TYPES[type])));
    });
  });
});
