import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { materializeDebugCorpus } from './agent-debug-fixtures.mjs';

// This intentionally tests the configured official package, not a mock or a local fork.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-mcp-smoke-'));
const { paths } = await materializeDebugCorpus(temporary);
const configuration = JSON.parse(
  await fs.readFile(new URL('../plugins/electivus-debug/mcp.json', import.meta.url), 'utf8')
);
const server = configuration.mcpServers['apex-log-mcp'];
assert.ok(server.args.includes('--no-apex-execution'));
const child = spawn(server.command, server.args, {
  cwd: temporary,
  env: { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true' },
  stdio: ['pipe', 'pipe', 'pipe']
});
let nextId = 0;
let buffer = '';
let stderr = '';
let closed = false;
const pending = new Map();
const exited = new Promise(resolve => child.once('close', resolve));
function fail(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}
child.stderr.on('data', chunk => {
  stderr = `${stderr}${chunk}`.slice(-8000);
});
child.on('error', fail);
child.stdin.on('error', fail);
child.on('close', code => {
  closed = true;
  fail(new Error(`MCP exited ${code}: ${stderr}`));
});
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error(`Non-JSON MCP stdout: ${line.slice(0, 160)}`));
      continue;
    }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
function request(method, params, timeout = 60000) {
  return new Promise((resolve, reject) => {
    if (closed) return reject(new Error(`MCP is closed: ${stderr}`));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out: ${stderr}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const asText = result =>
  result.content
    ?.filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n') ?? '';
async function call(name, args, { error = false } = {}) {
  const result = await request('tools/call', { name, arguments: args });
  assert.equal(Boolean(result.isError), error, `${name}: ${asText(result)}`);
  return asText(result);
}

try {
  const initialized = await request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'electivus-integration-test', version: '0.1.0' }
    },
    180000
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const { tools } = await request('tools/list', {});
  for (const name of [
    'apexlog_get_summary',
    'apexlog_list_slow_operations',
    'apexlog_list_limit_risks',
    'apexlog_execute_anonymous'
  ])
    assert.ok(
      tools.some(tool => tool.name === name),
      name
    );
  const fatal = await call('apexlog_get_summary', { logFilePath: paths['functional-failure'] });
  assert.match(fatal, /fatalErrors/);
  assert.match(fatal, /NullPointerException/);
  const caught = await call('apexlog_get_summary', { logFilePath: paths['caught-exception'] });
  assert.doesNotMatch(caught, /fatalErrors/);
  const limits = await call('apexlog_list_limit_risks', { logFilePath: paths['governor-limit'] });
  assert.match(limits, /101/);
  const slow = await call('apexlog_list_slow_operations', { logFilePath: paths['governor-limit'] });
  assert.match(slow, /SOQL_EXECUTE_BEGIN|CheckoutService/);
  const partial = await call('apexlog_get_summary', { logFilePath: paths['partial-low-detail'] });
  assert.match(partial, /truncated:\s*true/);
  assert.match(partial, /NONE/);
  // The fake explicit target prevents use of real auth even if the server regresses.
  const refused = await call(
    'apexlog_execute_anonymous',
    { apex: "System.debug('disabled smoke test');", targetOrg: 'electivus-smoke-no-such-org.invalid' },
    { error: true }
  );
  assert.match(refused, /disabled|no-apex-execution/i);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        server: initialized.serverInfo,
        tools: tools.map(tool => tool.name),
        cases: [
          'fatal',
          'caught-exception',
          'governor-limit',
          'slow-operations',
          'partial-low-detail',
          'execution-refused'
        ]
      },
      null,
      2
    )
  );
} finally {
  child.stdin.end();
  const shutdown = setTimeout(() => child.kill(), 5000);
  await exited;
  clearTimeout(shutdown);
  await fs.rm(temporary, { recursive: true, force: true });
}
