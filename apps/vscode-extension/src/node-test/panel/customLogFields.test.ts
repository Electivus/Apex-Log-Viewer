import assert from 'node:assert/strict';

import type { CustomLogEntryResult, CustomLogLongValue } from '@alv/core/contracts';
import { buildEntryFields, buildHeaderPayloadField, longFieldView } from '../../panel/customLogFields';

const labels = { message: 'Message', payload: 'Payload' };

function result(overrides: Partial<CustomLogEntryResult> = {}): CustomLogEntryResult {
  return {
    source: { id: 'nebula', label: 'Nebula Logger', shape: 'transactions' },
    logId: 'a02000000000001AAA',
    entry: {
      id: 'a01000000000001AAA',
      sequence: 4,
      time: '2026-10-30T00:48:10.000Z',
      message: 'Divide by 0',
      previewClipped: false,
      system: false,
      presentDetails: [],
      extra: {}
    },
    details: [],
    rawPayload: { state: 'unmapped' },
    ...overrides
  };
}

suite('Custom Logs long field views', () => {
  test('a view carries the state and format of a value and never its text', () => {
    const value: CustomLogLongValue = { state: 'value', value: 'secret text', format: 'json', truncated: true };

    const view = longFieldView('RecordJson__c', 'Record JSON', value);

    assert.deepEqual(view, {
      key: 'RecordJson__c',
      label: 'Record JSON',
      state: 'value',
      format: 'json',
      truncated: true
    });
    assert.equal(JSON.stringify(view).includes('secret'), false);
  });

  test('leaves the truncation flag out when the logger does not report one', () => {
    assert.deepEqual(longFieldView('k', 'K', { state: 'value', value: 'x', format: 'text' }), {
      key: 'k',
      label: 'K',
      state: 'value',
      format: 'text'
    });
  });

  test('keeps empty and hidden apart', () => {
    assert.deepEqual(longFieldView('k', 'K', { state: 'empty' }), { key: 'k', label: 'K', state: 'empty' });
    assert.deepEqual(longFieldView('k', 'K', { state: 'hidden' }), { key: 'k', label: 'K', state: 'hidden' });
  });

  test('builds the entry fields in display order, holding text only for readable values', () => {
    const built = buildEntryFields(
      result({
        details: [
          { key: 'StackTrace__c', label: 'Stack Trace', state: 'value', value: 'line 7', format: 'text' },
          { key: 'HttpRequestBody__c', label: 'Http Request Body', state: 'hidden' },
          { key: 'Tags__c', label: 'Tags', state: 'empty' },
          { key: 'Unused__c', label: 'Unused', state: 'unmapped' }
        ],
        rawPayload: { state: 'value', value: '{"orderId":1}', format: 'json' }
      }),
      labels
    );

    assert.deepEqual(
      built.views.map(view => [view.key, view.state]),
      [
        ['message', 'value'],
        ['StackTrace__c', 'value'],
        ['HttpRequestBody__c', 'hidden'],
        ['Tags__c', 'empty'],
        ['payload', 'value']
      ]
    );
    assert.deepEqual([...built.held.keys()], ['message', 'StackTrace__c', 'payload']);
    assert.deepEqual(built.held.get('payload'), { label: 'Payload', text: '{"orderId":1}', format: 'json' });
  });

  test("the message field has the full text, its own format and the logger's truncation flag", () => {
    const json = buildEntryFields(
      result({ entry: { ...result().entry, message: '{"event":"sync"}', messageTruncated: false } }),
      labels
    );
    assert.deepEqual(json.views[0], {
      key: 'message',
      label: 'Message',
      state: 'value',
      format: 'json',
      truncated: false
    });

    const broken = buildEntryFields(result({ entry: { ...result().entry, message: '{"event":' } }), labels);
    assert.equal(broken.views[0]?.format, 'text');

    const empty = buildEntryFields(result({ entry: { ...result().entry, message: '' } }), labels);
    assert.deepEqual(empty.views[0], { key: 'message', label: 'Message', state: 'empty' });
    assert.equal(empty.held.has('message'), false);
  });

  test('a source without a payload mapping offers no payload field', () => {
    const built = buildEntryFields(result({ rawPayload: { state: 'unmapped' } }), labels);

    assert.equal(
      built.views.some(view => view.key === 'payload'),
      false
    );
  });

  test('a hidden payload is still announced, so the viewer can say why it cannot be opened', () => {
    const built = buildEntryFields(result({ rawPayload: { state: 'hidden' } }), labels);

    assert.deepEqual(built.views.at(-1), { key: 'payload', label: 'Payload', state: 'hidden' });
  });

  test('the header payload of a transaction exists only when the source maps one', () => {
    assert.equal(buildHeaderPayloadField(undefined, 'Payload'), undefined);
    assert.equal(buildHeaderPayloadField({ state: 'unmapped' }, 'Payload'), undefined);
    assert.deepEqual(buildHeaderPayloadField({ state: 'hidden' }, 'Payload'), {
      view: { key: 'payload', label: 'Payload', state: 'hidden' }
    });
    assert.deepEqual(buildHeaderPayloadField({ state: 'value', value: '{}', format: 'json' }, 'Payload'), {
      view: { key: 'payload', label: 'Payload', state: 'value', format: 'json' },
      held: { label: 'Payload', text: '{}', format: 'json' }
    });
  });
});
