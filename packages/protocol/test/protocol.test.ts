import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugFlagsFromWebviewMessage } from '../src/debugFlagsMessages.ts';
import { normalizeLogsColumnsConfig } from '../src/logsColumns.ts';
import { parseWebviewToExtensionMessage } from '../src/messages.ts';

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
