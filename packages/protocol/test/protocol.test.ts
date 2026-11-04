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

test('protocol keeps the trace flag log type of debug flags target, apply and remove messages', () => {
  const target = { type: 'user', userId: '005000000000001AAA' };
  const apply = { target, debugLevelName: 'ALV_E2E', ttlMinutes: 30 };

  assert.deepEqual(
    parseDebugFlagsFromWebviewMessage({ type: 'debugFlagsSelectTarget', target, logType: 'USER_DEBUG' }),
    {
      type: 'debugFlagsSelectTarget',
      target,
      logType: 'USER_DEBUG'
    }
  );
  assert.deepEqual(parseDebugFlagsFromWebviewMessage({ type: 'debugFlagsApply', ...apply, logType: 'DEVELOPER_LOG' }), {
    type: 'debugFlagsApply',
    ...apply,
    logType: 'DEVELOPER_LOG'
  });
  assert.deepEqual(parseDebugFlagsFromWebviewMessage({ type: 'debugFlagsRemove', target, logType: 'DEVELOPER_LOG' }), {
    type: 'debugFlagsRemove',
    target,
    logType: 'DEVELOPER_LOG'
  });
});

test('protocol rejects debug flags target, apply and remove messages without a known log type', () => {
  const target = { type: 'automatedProcess' };
  const messages = [
    { type: 'debugFlagsSelectTarget', target },
    { type: 'debugFlagsApply', target, debugLevelName: 'ALV_E2E', ttlMinutes: 30 },
    { type: 'debugFlagsRemove', target }
  ];
  const logTypes = [undefined, 'SYSTEM_LOG', 'developer_log', "USER_DEBUG' OR Id != '", 1];

  const parsed = messages.flatMap(message =>
    logTypes.map(logType => parseDebugFlagsFromWebviewMessage({ ...message, logType }))
  );

  assert.deepEqual(parsed, Array(messages.length * logTypes.length).fill(undefined));
});

test('protocol normalizes invalid column preferences to a usable layout', () => {
  const normalized = normalizeLogsColumnsConfig({ order: ['status', 'invalid', 'status'] });
  assert.equal(normalized.order[0], 'status');
  assert.equal(new Set(normalized.order).size, normalized.order.length);
  assert.equal(normalized.order.includes('user'), true);
});
