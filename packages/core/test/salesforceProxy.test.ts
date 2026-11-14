import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import {
  answerRest,
  isolateSalesforceHome,
  saveOrgAuth,
  startSalesforceDouble,
  type DoubleHandler
} from './support/salesforceDouble.ts';

isolateSalesforceHome();

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

const oneUser: DoubleHandler = request =>
  request.path === '/query'
    ? {
        body: {
          totalSize: 1,
          done: true,
          records: [{ Id: '005000000000001AAA', Name: 'Demo', Username: 'demo@example.com', IsActive: true }]
        }
      }
    : { status: 404, body: [{ errorCode: 'NOT_FOUND', message: request.path }] };

type RecordingProxy = { url: string; seen: string[] };

async function startRecordingProxy(t: test.TestContext, handler: DoubleHandler = oneUser): Promise<RecordingProxy> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    answerRest(request, response, handler, []);
  });
  server.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

type ChildResult = { ok: boolean; users?: number; error?: string; configured?: string; elapsedMs: number };

async function searchUsersInChild(
  username: string,
  variables: Record<string, string>,
  settings?: unknown
): Promise<ChildResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...PROXY_VARIABLES, 'HTTP_TIMEOUT']) delete env[name];
  Object.assign(env, variables);
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve(__dirname, 'support/salesforceProxyChild.ts'),
      username,
      ...(settings === undefined ? [] : [JSON.stringify(settings)])
    ],
    { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  await new Promise(resolve => child.on('close', resolve));
  clearTimeout(killer);
  const line = output.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as ChildResult;
  } catch {
    throw new Error(`the child printed no result:\n${output}`);
  }
}

async function orgBehind(t: test.TestContext, username: string, handler: DoubleHandler = oneUser) {
  const salesforce = await startSalesforceDouble(t, handler);
  await saveOrgAuth(username, salesforce.instanceUrl);
  return salesforce;
}

const proxiedQueries = (proxy: RecordingProxy) => proxy.seen.filter(line => line.includes('/query'));

test('an environment proxy leaves the hosts NO_PROXY names alone', async t => {
  await orgBehind(t, 'no-proxy@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild('no-proxy@example.com', {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    NO_PROXY: '127.0.0.1'
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(proxy.seen, []);
});

test('an environment proxy carries the requests NO_PROXY does not name', async t => {
  await orgBehind(t, 'env-proxy@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild('env-proxy@example.com', {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    NO_PROXY: 'login.example.com'
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(proxy).length, 1);
});

test('a configured proxy URL carries the requests when no proxy variable is set', async t => {
  await orgBehind(t, 'settings-proxy@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild('settings-proxy@example.com', {}, { proxyUrl: proxy.url, noProxy: [] });

  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(proxy).length, 1);
});

test('configured bypass hosts replace NO_PROXY instead of adding to it', async t => {
  await orgBehind(t, 'settings-bypass@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild(
    'settings-bypass@example.com',
    { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1' },
    { noProxy: ['login.example.com'] }
  );

  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(proxy).length, 1);
});

test('a proxy URL without a usable scheme and host is ignored for the environment proxy', async t => {
  await orgBehind(t, 'bad-setting@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild(
    'bad-setting@example.com',
    { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
    { proxyUrl: 'proxy.company.com:8080' }
  );

  assert.equal(result.configured, 'ignored-proxy-url');
  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(proxy).length, 1);
});

test('an environment proxy without a usable scheme and host is skipped for a direct connection', async t => {
  const salesforce = await orgBehind(t, 'bad-variable@example.com');

  const result = await searchUsersInChild('bad-variable@example.com', {
    HTTP_PROXY: 'proxy.company.com:8080',
    HTTPS_PROXY: 'proxy.company.com:8080'
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(salesforce.requests.length, 1);
});

test('HTTP_TIMEOUT still bounds each Salesforce request', async t => {
  await orgBehind(t, 'timeout@example.com', async request => {
    if (request.path === '/query') await new Promise(resolve => setTimeout(resolve, 20_000).unref());
    return oneUser(request);
  });

  const result = await searchUsersInChild('timeout@example.com', { HTTP_TIMEOUT: '1000' });

  assert.equal(result.ok, false);
  assert.ok(result.elapsedMs < 15_000, `the request ran ${result.elapsedMs} ms under a 1000 ms HTTP_TIMEOUT`);
});
