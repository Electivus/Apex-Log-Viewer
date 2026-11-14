import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Connection } from '@jsforce/jsforce-node';
import { configureSalesforceProxy } from '@alv/core';
import proxyquire from 'proxyquire';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

type Listening = { url: string; seen: string[]; close(): Promise<void> };

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function closer(server: http.Server): () => Promise<void> {
  return () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

const answerLimits = (response: http.ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ DailyApiRequests: { Max: 15000, Remaining: 14999 } }));
};

async function startSalesforce(): Promise<Listening> {
  const seen: string[] = [];
  const server = await listen((request, response) => {
    seen.push(request.url ?? '');
    answerLimits(response);
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: closer(server) };
}

async function startProxy(): Promise<Listening> {
  const seen: string[] = [];
  const server = await listen((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    answerLimits(response);
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: closer(server) };
}

type ConfigurationEvent = { affectsConfiguration(key: string): boolean };

function loadProxyAdapter(settings: Record<string, unknown>) {
  const listeners: Array<(event: ConfigurationEvent) => void> = [];
  const warnings: string[] = [];
  const { registerSalesforceProxy } = proxyquireStrict('../../host/salesforce/proxy', {
    vscode: {
      workspace: {
        onDidChangeConfiguration: (listener: (event: ConfigurationEvent) => void) => {
          listeners.push(listener);
          return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
        }
      }
    },
    '../utils/config': {
      getConfig: (name: string, fallback: unknown) => (name in settings ? settings[name] : fallback),
      affectsConfiguration: (event: ConfigurationEvent, name: string) => event.affectsConfiguration(name)
    },
    '../utils/logger': { logWarn: (...parts: unknown[]) => warnings.push(parts.join(' ')) }
  });
  const change = (name: string, value: unknown) => {
    settings[name] = value;
    for (const listener of [...listeners]) listener({ affectsConfiguration: key => key === name });
  };
  return { registration: registerSalesforceProxy() as { dispose(): void }, change, warnings };
}

suite('VS Code proxy settings for Salesforce requests', () => {
  const savedEnvironment: Record<string, string | undefined> = {};
  let salesforce: Listening;
  let proxy: Listening;

  const requestLimits = async () => {
    const connection = new Connection({ instanceUrl: salesforce.url, accessToken: 'token', version: '64.0' });
    await connection.request('/services/data/v64.0/limits');
  };

  suiteSetup(() => {
    for (const name of PROXY_VARIABLES) {
      savedEnvironment[name] = process.env[name];
      delete process.env[name];
    }
  });

  suiteTeardown(() => {
    for (const name of PROXY_VARIABLES) {
      if (savedEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnvironment[name];
    }
    configureSalesforceProxy();
  });

  setup(async () => {
    salesforce = await startSalesforce();
    proxy = await startProxy();
  });

  teardown(async () => {
    await salesforce.close();
    await proxy.close();
  });

  test('sends the requests of a jsforce connection through http.proxy when no proxy variable is set', async () => {
    const { registration } = loadProxyAdapter({ 'http.proxy': proxy.url });
    try {
      await requestLimits();
      assert.deepEqual(proxy.seen, [`GET ${salesforce.url}/services/data/v64.0/limits`]);
    } finally {
      registration.dispose();
    }
  });

  test('follows a change to http.noProxy without a reload', async () => {
    const { registration, change } = loadProxyAdapter({ 'http.proxy': proxy.url });
    try {
      await requestLimits();
      change('http.noProxy', ['127.0.0.1']);
      await requestLimits();
      assert.equal(proxy.seen.length, 1);
      assert.equal(salesforce.seen.length, 1);
    } finally {
      registration.dispose();
    }
  });

  test('leaves http.proxy aside when http.proxySupport is off', async () => {
    const { registration } = loadProxyAdapter({ 'http.proxy': proxy.url, 'http.proxySupport': 'off' });
    try {
      await requestLimits();
      assert.deepEqual(proxy.seen, []);
      assert.equal(salesforce.seen.length, 1);
    } finally {
      registration.dispose();
    }
  });

  test('warns about an http.proxy it cannot use without repeating its credentials', async () => {
    const { registration, warnings } = loadProxyAdapter({ 'http.proxy': 'user:secret@proxy.corp:8080' });
    try {
      await requestLimits();
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(warnings[0] ?? '', /secret|proxy\.corp/);
      assert.equal(salesforce.seen.length, 1);
    } finally {
      registration.dispose();
    }
  });
});
