import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('createServer registers apexLogsSync tool', () => {
  const server = createServer();
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;

  assert.ok(tools);
  assert.ok(tools.apexLogsSync);
});

test('apexLogsSync tool includes title, description, and annotations', () => {
  const server = createServer();
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  const tool = tools.apexLogsSync as {
    title?: string;
    description?: string;
    annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  };

  assert.ok(tool.title?.includes('Apex Log Viewer'));
  assert.ok(tool.description?.includes('Apex log'));
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.openWorldHint, true);
});

test('apexLogsSync tool returns structuredContent', async () => {
  const runApexLogsSync = async () => ({ status: 0 });
  const server = createServer({ runApexLogsSync });
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  const tool = tools.apexLogsSync as { handler: (args: unknown, extra: unknown) => Promise<{ content: unknown[]; structuredContent?: unknown }> };
  const result = await tool.handler({ limit: 1 }, {});

  assert.ok(Array.isArray(result.content));
  assert.deepEqual(result.structuredContent, { status: 0 });
});
