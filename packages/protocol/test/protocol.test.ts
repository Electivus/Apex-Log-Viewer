import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugFlagsFromWebviewMessage } from '../src/debugFlagsMessages.ts';
import { normalizeLogsColumnsConfig } from '../src/logsColumns.ts';
import { parseMessageSentAt, parseWebviewToExtensionMessage } from '../src/messages.ts';

test('protocol reads a positive integer sentAt stamp from any webview message', () => {
  assert.equal(parseMessageSentAt({ type: 'refresh', sentAt: 1_760_000_000_123 }), 1_760_000_000_123);
  assert.equal(parseMessageSentAt({ type: 'not-a-command', sentAt: 1 }), 1);
});

test('protocol ignores a missing or malformed sentAt stamp', () => {
  const rejected = [
    { type: 'refresh' },
    { type: 'refresh', sentAt: 0 },
    { type: 'refresh', sentAt: -1000 },
    { type: 'refresh', sentAt: 1000.5 },
    { type: 'refresh', sentAt: Number.NaN },
    { type: 'refresh', sentAt: Number.POSITIVE_INFINITY },
    { type: 'refresh', sentAt: '1000' },
    [1000],
    null,
    1000
  ].map(parseMessageSentAt);

  assert.deepEqual(rejected, Array(10).fill(undefined));
});

test('protocol validation ignores the sentAt stamp', () => {
  assert.deepEqual(parseWebviewToExtensionMessage({ type: 'refresh', sentAt: 1000 }), { type: 'refresh' });
});

test('protocol rejects unknown webview messages', () => {
  assert.equal(parseWebviewToExtensionMessage({ type: 'not-a-command' }), undefined);
  assert.equal(parseDebugFlagsFromWebviewMessage({ type: 'not-a-command' }), undefined);
});

test('protocol normalizes invalid column preferences to a usable layout', () => {
  const normalized = normalizeLogsColumnsConfig({ order: ['status', 'invalid', 'status'] });
  assert.equal(normalized.order[0], 'status');
  assert.equal(new Set(normalized.order).size, normalized.order.length);
  assert.equal(normalized.order.includes('user'), true);
});
