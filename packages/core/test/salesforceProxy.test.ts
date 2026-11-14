import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
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

async function startRecordingProxy(
  t: test.TestContext,
  handler: DoubleHandler = oneUser,
  host = '127.0.0.1'
): Promise<RecordingProxy> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    answerRest(request, response, handler, []);
  });
  server.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const shown = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${shown}:${(server.address() as AddressInfo).port}`, seen };
}

type ChildResult = { ok: boolean; users?: number; error?: string; elapsedMs: number };

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

test('a configured proxy URL wins over the proxy variables', async t => {
  await orgBehind(t, 'settings-precedence@example.com');
  const configured = await startRecordingProxy(t);
  const environment = await startRecordingProxy(t);

  const result = await searchUsersInChild(
    'settings-precedence@example.com',
    { HTTP_PROXY: environment.url, HTTPS_PROXY: environment.url },
    { proxyUrl: configured.url }
  );

  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(configured).length, 1);
  assert.deepEqual(environment.seen, []);
});

const UNUSABLE_PROXY = 'user:secret@proxy.company.com:8080';

type Listener = { url: string; seen: string[] };

async function listenOn(t: test.TestContext, server: net.Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, host, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** A SOCKS5 server that records the CONNECT target and always tunnels to the org double, whatever was asked. */
async function startSocksProxy(t: test.TestContext, scheme: string, orgPort: number): Promise<Listener> {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', request => {
        const port = request.readUInt16BE(request.length - 2);
        const host =
          request[3] === 1
            ? [...request.subarray(4, 8)].join('.')
            : request.subarray(5, 5 + request.readUInt8(4)).toString();
        seen.push(`CONNECT ${host}:${port}`);
        const upstream = net.connect(orgPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
      });
    });
  });
  t.after(() => sockets.forEach(socket => socket.destroy()));
  const port = await listenOn(t, server);
  return { url: `${scheme}://127.0.0.1:${port}`, seen };
}

/** Accepts and drops connections: an https:// proxy URL reaches it with a TLS handshake it never answers. */
async function startConnectionRecorder(t: test.TestContext): Promise<Listener> {
  const seen: string[] = [];
  const server = net.createServer(socket => {
    seen.push('connection');
    socket.destroy();
  });
  const port = await listenOn(t, server);
  return { url: `https://127.0.0.1:${port}`, seen };
}

/** Values that must never route anywhere: each fails its protocol with the named error, bypass hosts included. */
const MALFORMED: Array<{ value: string; paths?: readonly Path[] }> = [
  { value: 'proxy.company.com:8080' },
  { value: UNUSABLE_PROXY },
  { value: 'ftp://user:secret@proxy.company.com:21' },
  { value: '//proxy.company.com:8080' },
  { value: 'http://' },
  { value: 'http://:8080' },
  { value: 'http://user:secret@' },
  { value: 'http://user:%zz@proxy.company.com:8080' },
  { value: 'socks:' },
  { value: 'socks://' },
  { value: 'socks:/proxy.company.com:8080' },
  { value: 'socks5:///proxy.company.com:8080' },
  { value: 'socks5://:1080' },
  { value: 'socks5://user:secret@' },
  { value: 'http://proxy.company.com:8080/corporate/' },
  { value: 'http://proxy.company.com:8080/?region=1' },
  { value: '   ', paths: ['environment'] }
];

type WellFormed = {
  name: string;
  start: (t: test.TestContext, orgPort: number) => Promise<Listener>;
  value?: (url: string) => string;
  /** What reaching the listener looks like: a REST answer through it, or only a connection. */
  carries: boolean;
};

const recording = (host?: string) => async (t: test.TestContext) => {
  const proxy = await startRecordingProxy(t, oneUser, host);
  return { url: proxy.url, seen: proxy.seen };
};

const WELL_FORMED: WellFormed[] = [
  { name: 'http://host:port', start: recording(), carries: true },
  { name: 'HTTP:// in capitals', start: recording(), value: url => url.replace('http:', 'HTTP:'), carries: true },
  {
    name: 'http:// with credentials',
    start: recording(),
    value: url => url.replace('http://', 'http://user:secret@'),
    carries: true
  },
  { name: 'http:// with a trailing slash', start: recording(), value: url => `${url}/`, carries: true },
  { name: 'http:// inside spaces', start: recording(), value: url => `  ${url}  `, carries: true },
  { name: 'http://[::1]:port', start: recording('::1'), carries: true },
  { name: 'socks://host:port', start: (t, orgPort) => startSocksProxy(t, 'socks', orgPort), carries: true },
  { name: 'socks5://host:port', start: (t, orgPort) => startSocksProxy(t, 'socks5', orgPort), carries: true },
  { name: 'https://host:port', start: startConnectionRecorder, carries: false }
];

type Path = 'environment' | 'settings';

function proxyInput(path: Path, value: string, bypass: boolean): [Record<string, string>, unknown] {
  if (path === 'environment') return [{ HTTP_PROXY: value, ...(bypass ? { NO_PROXY: '127.0.0.1' } : {}) }, undefined];
  return [{}, { proxyUrl: value, ...(bypass ? { noProxy: ['127.0.0.1'] } : {}) }];
}

const PATHS: readonly Path[] = ['environment', 'settings'];
const sourceName = (path: Path) => (path === 'environment' ? /HTTP_PROXY/ : /http\.proxy/);

test(
  'which proxy values route and which fail closed, through the variables and the settings',
  { concurrency: 8 },
  async t => {
    let user = 0;
    const cases: Array<{ name: string; run: () => Promise<void> }> = [];

    for (const { value, paths = PATHS } of MALFORMED) {
      for (const path of paths) {
        for (const bypass of [false, true]) {
          const username = `table-${user++}@example.com`;
          const salesforce = await orgBehind(t, username);
          cases.push({
            name: `${JSON.stringify(value)} in ${path}${bypass ? ' with a matching bypass' : ''} fails with the named error`,
            run: async () => {
              const result = await searchUsersInChild(username, ...proxyInput(path, value, bypass));
              assert.equal(result.ok, false);
              assert.match(result.error ?? '', /were not sent/);
              assert.match(result.error ?? '', sourceName(path));
              assert.doesNotMatch(result.error ?? '', /secret|proxy\.company/);
              assert.equal(salesforce.received, 0);
            }
          });
        }
      }
    }

    for (const proxy of WELL_FORMED) {
      for (const path of PATHS) {
        for (const bypass of [false, true]) {
          const username = `table-${user++}@example.com`;
          const salesforce = await orgBehind(t, username);
          const listener = await proxy.start(t, Number(new URL(salesforce.instanceUrl).port));
          const value = proxy.value ? proxy.value(listener.url) : listener.url;
          cases.push({
            name: `${proxy.name} in ${path}${bypass ? ' with a matching bypass goes direct' : ' carries the request'}`,
            run: async () => {
              const result = await searchUsersInChild(username, ...proxyInput(path, value, bypass));
              if (bypass) {
                assert.equal(result.ok, true, result.error);
                assert.deepEqual(listener.seen, []);
                assert.ok(salesforce.received > 0);
              } else if (proxy.carries) {
                assert.equal(result.ok, true, result.error);
                assert.ok(listener.seen.length > 0, 'the proxy saw no request');
              } else {
                assert.equal(result.ok, false);
                assert.doesNotMatch(result.error ?? '', /were not sent/);
                assert.ok(listener.seen.length > 0, 'the proxy saw no connection');
                assert.equal(salesforce.received, 0);
              }
            }
          });
        }
      }
    }

    await Promise.all(cases.map(({ name, run }) => t.test(name, run)));
  }
);

test('a valid HTTP_PROXY carries http requests when HTTPS_PROXY is unusable', async t => {
  await orgBehind(t, 'bad-https-variable@example.com');
  const proxy = await startRecordingProxy(t);

  const result = await searchUsersInChild('bad-https-variable@example.com', {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: 'proxy.company.com:8080'
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(proxiedQueries(proxy).length, 1);
});

test('a valid HTTPS_PROXY carries https requests when HTTP_PROXY is unusable', async t => {
  const salesforce = await startSalesforceDouble(t, oneUser);
  const httpsInstance = salesforce.instanceUrl.replace(/^http:/, 'https:');
  await saveOrgAuth('bad-http-variable@example.com', httpsInstance);
  const proxy = await startRecordingProxy(t);

  await searchUsersInChild('bad-http-variable@example.com', {
    HTTP_PROXY: 'proxy.company.com:8080',
    HTTPS_PROXY: proxy.url
  });

  assert.ok(
    proxy.seen.includes(`CONNECT ${new URL(httpsInstance).host}`),
    `the HTTPS proxy saw ${JSON.stringify(proxy.seen)}`
  );
  assert.equal(salesforce.received, 0);
});

test('on Windows a proxy variable in any letter case carries the requests and names its own spelling', async t => {
  const salesforce = await orgBehind(t, 'windows-case@example.com');
  const proxy = await startRecordingProxy(t);

  const carried = await searchUsersInChild(
    'windows-case@example.com',
    { Http_Proxy: proxy.url, ALV_TEST_PLATFORM: 'win32' },
    {}
  );
  const refused = await searchUsersInChild(
    'windows-case@example.com',
    { Http_Proxy: UNUSABLE_PROXY, ALV_TEST_PLATFORM: 'win32' },
    {}
  );

  assert.equal(carried.ok, true, carried.error);
  assert.equal(proxiedQueries(proxy).length, 1);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /Http_Proxy/);
  assert.equal(salesforce.received, 0);
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
