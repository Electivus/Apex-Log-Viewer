import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('createServer registers apexLogsSync tool', () => {
  const server = createServer();
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

  assert.ok(tools);
  assert.ok(tools.apexLogsSync);
});
