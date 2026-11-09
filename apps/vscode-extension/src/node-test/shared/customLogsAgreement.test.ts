import assert from 'node:assert/strict';

import { parseCustomLogsFromWebviewMessage } from '@alv/protocol/customLogsMessages';
import { parseCustomLogLevel, parseSinceValue } from '@alv/protocol/customLogsRules';
import {
  CUSTOM_LOG_LEVELS,
  EVENT_ROW_ID_PATTERN,
  mergeLiveRows,
  mergePayloadFields,
  parseCustomLogRowId,
  type CustomLogPayloadField,
  type CustomLogPayloadType,
  type CustomLogPayloadView
} from '@alv/protocol/customLogsTypes';

import { matchesSearch, parseSearch, rowSearchText } from '../../../../../packages/webview/src/utils/customLogs/search';
import {
  coreConfig,
  coreContracts,
  coreEventIds,
  coreLevels,
  corePayload,
  coreSince,
  coreSoql
} from '../coreInternals';

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
        assert.equal(parseCustomLogRowId(id) !== undefined, coreSoql.isSalesforceId(id));
      });
    }

    const eventIds = [
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-000000000-0000000000-00000000000000000000000000000000',
      'e-zzzzzzzzz-zzzzzzzzzz-ffffffffffffffffffffffffffffffff',
      'E-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-0R5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-0r5jq8z3k-00000000a1-0A1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-0r5jq8z3-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d0',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      'e-0r5jq8z3k_00000000a1_0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-0001',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-zzzz',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-0000',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-001',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-00001',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-000A',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-0001x',
      'e-0r5jq8z3k-00000000a1-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d-',
      ''
    ];

    test('keeps the event id pattern identical to core, so a regex edit in one package fails here', () => {
      assert.equal(EVENT_ROW_ID_PATTERN.source, coreContracts.CUSTOM_LOG_EVENT_ID_PATTERN.source);
      assert.equal(EVENT_ROW_ID_PATTERN.flags, coreContracts.CUSTOM_LOG_EVENT_ID_PATTERN.flags);
    });

    for (const id of eventIds) {
      test(`treats the event id ${JSON.stringify(id)} like core`, () => {
        const coreAccepts = coreContracts.CUSTOM_LOG_EVENT_ID_PATTERN.test(id) || coreSoql.isSalesforceId(id);
        assert.equal(parseCustomLogRowId(id) !== undefined, coreAccepts);
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

  suite('live row order', () => {
    const eventId = (createdMs: number, seq: number, uuidTail: number) =>
      `e-${createdMs.toString(36).padStart(9, '0')}-${seq.toString(36).padStart(10, '0')}-${uuidTail.toString(16).padStart(32, '0')}`;

    test('merges event rows into the order core lists them, ties on time, sequence, uuid and entry ordinal included', () => {
      const positions = [0, 1, 2].flatMap(time =>
        [0, 1].flatMap(seq =>
          [0, 1].flatMap(tail =>
            [0, 1, 2].map(ordinal => ({
              ...coreEventIds.parseEntryRowId(eventId(1_790_000_000_000 + time, seq, tail))!,
              ordinal
            }))
          )
        )
      );
      const listed = positions
        .sort(coreEventIds.compareEntriesNewestFirst)
        .map(position => ({ id: coreEventIds.entryRowId(position) }));

      for (const stride of [2, 3, 5]) {
        const loaded = listed.filter((_, index) => index % stride === 0);
        const incoming = listed.filter((_, index) => index % stride !== 0).reverse();
        assert.deepEqual(mergeLiveRows(loaded, incoming, { hasMore: false }), listed, `every ${stride}th row loaded`);
      }
    });
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

  suite('payload paths and the search', () => {
    const payloads = [
      '[{"status":500},{"status":200}]',
      '[[{"x":1}],[2,3]]',
      '{"items":[{"id":"a"},{"id":"b"}],"tags":["vip"]}',
      '{"200":{"ok":true},"descrição":"x","@type":"t","a:b":1,"http://x/y":2,"$ref":"#"}',
      '{"Account Name":"Acme","a=b":1,"x>=y":2,"!flag":true,"say \\"hi\\"":1,"it\'s":2,"tab\\tkey":3}',
      '{"and":1,"or":2,"exists":3,"contains":4,"a":{"":5},"  padded ":6,"nothing":null,"off":false,"zero":0}',
      '{"level":"WARN","user":"x","since":"1h","source":"s","LEVEL":2}'
    ];

    for (const payload of payloads) {
      test(`finds every path and value core decodes in ${payload}`, () => {
        const view = corePayload.decodePayload(payload);
        assert.equal(view.state, 'parsed');
        const values = view.state === 'parsed' ? view.values : {};
        const text = rowSearchText({
          id: 'a0B5g00000Zt1QwEAJ',
          time: '2026-10-30T12:00:00Z',
          extra: {},
          payload: view
        });
        for (const [path, value] of Object.entries(values)) {
          assert.ok(matchesSearch(text, parseSearch(path)), `path ${path}`);
          assert.ok(matchesSearch(text, parseSearch(String(value))), `value ${String(value)} at ${path}`);
        }
      });
    }
  });
});
