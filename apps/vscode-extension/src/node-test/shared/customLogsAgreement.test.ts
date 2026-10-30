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

import {
  formatFilterCondition,
  parseFilterExpression
} from '../../../../../packages/webview/src/utils/customLogs/filterGrammar';
import { normalizePayloadPath, payloadMatches } from '../../../../../packages/webview/src/utils/customLogs/payloadRows';
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

  suite('payload paths and the filter grammar', () => {
    const payloads = [
      '[{"status":500},{"status":200}]',
      '[[{"x":1}],[2,3]]',
      '{"items":[{"id":"a"},{"id":"b"}],"tags":["vip"]}',
      '{"200":{"ok":true},"descrição":"x","@type":"t","a:b":1,"http://x/y":2,"$ref":"#"}',
      '{"Account Name":"Acme","a=b":1,"x>=y":2,"!flag":true,"say \\"hi\\"":1,"it\'s":2,"tab\\tkey":3}',
      '{"and":1,"or":2,"exists":3,"contains":4,"a":{"":5}," padded ":6}'
    ];

    for (const payload of payloads) {
      test(`writes every path core finds in ${payload} as a filter that reads back to it, indexed and grouped`, () => {
        const view = corePayload.decodePayload(payload);
        assert.equal(view.state, 'parsed');
        const paths = Object.keys(view.state === 'parsed' ? view.values : {});
        for (const path of new Set(paths.flatMap(raw => [raw, normalizePayloadPath(raw)]))) {
          const written = formatFilterCondition({ field: path, op: '>=', value: '500' });
          const parsed = parseFilterExpression(written);
          assert.deepEqual(
            parsed.ok ? parsed.conditions.map(condition => condition.field) : parsed.error,
            [path],
            written
          );
        }
      });
    }

    test('matches a root-array payload decoded by core with the filters its paths write', () => {
      const view = corePayload.decodePayload('[{"status":500},{"status":200}]');
      const verdicts = ['[].status >= 500', '[0].status >= 500', '[1].status >= 500', '[].status < 100'].map(source => {
        const parsed = parseFilterExpression(source);
        assert.ok(parsed.ok, source);
        return parsed.conditions.every(condition => payloadMatches(view, condition));
      });
      assert.deepEqual(verdicts, [true, true, false, false]);
    });
  });
});
