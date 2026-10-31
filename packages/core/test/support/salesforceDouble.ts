import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { AuthInfo, Connection, StateAggregator } from '@salesforce/core';

export const ORG_ID = '00D000000000001AAA';

/**
 * Points the Salesforce SDK at a throwaway home so saved auth never touches the developer's. Call it
 * once at the top of a test file, before the first SDK call: `node --test` runs each file in its own process.
 */
export function isolateSalesforceHome(): void {
  const originalCwd = process.cwd();
  const sfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-sf-home-'));
  process.env.HOME = sfHome;
  process.env.USERPROFILE = sfHome;
  process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
  process.env.SF_DISABLE_LOG_FILE = 'true';
  process.env.SF_DISABLE_DNS_CHECK = 'true';
  process.env.SFDX_IGNORE_API_VERSION_CACHE = 'true';
  process.chdir(sfHome);
  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(sfHome, { recursive: true, force: true });
  });
}

export type DoubleRequest = {
  method: string;
  /** Path with the `/services/data/vNN.N` prefix removed, for example `/query` or `/tooling/query`. */
  path: string;
  query: URLSearchParams;
  body: string;
};

export type DoubleResponse = { status?: number; body: unknown };
export type DoubleHandler = (request: DoubleRequest) => DoubleResponse | Promise<DoubleResponse>;

export type SalesforceDouble = {
  instanceUrl: string;
  /** Every request the double answered, oldest first, version listing excluded. */
  requests: DoubleRequest[];
  /** Every HTTP request that reached the server, the version listing included: a connection that lists versions and queries nothing still counts. */
  readonly received: number;
};

/** Answers one REST request: the version list itself, every other request through `handler` and recorded in `requests`. */
export function answerRest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  handler: DoubleHandler,
  requests: DoubleRequest[]
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk as Buffer));
  request.on('end', () => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/services/data') {
      send(200, [{ label: 'Test', url: '/services/data/v63.0', version: '63.0' }]);
      return;
    }
    const seen: DoubleRequest = {
      method: request.method ?? 'GET',
      path: url.pathname.replace(/^\/services\/data\/v[\d.]+/, ''),
      query: url.searchParams,
      body: Buffer.concat(chunks).toString('utf8')
    };
    requests.push(seen);
    Promise.resolve(handler(seen)).then(
      answer => send(answer.status ?? 200, answer.body),
      (error: unknown) => send(500, [{ message: String(error), errorCode: 'DOUBLE_FAILURE' }])
    );
  });
}

/** A Salesforce REST double: it answers the version list itself and hands every other request to `handler`. */
export async function startSalesforceDouble(t: test.TestContext, handler: DoubleHandler): Promise<SalesforceDouble> {
  const requests: DoubleRequest[] = [];
  let received = 0;
  const server = http.createServer((request, response) => {
    received++;
    answerRest(request, response, handler, requests);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return {
    instanceUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    get received() {
      return received;
    }
  };
}

export async function saveOrgAuth(username: string, instanceUrl: string, accessToken = 'token-double'): Promise<void> {
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    orgEdition: 'Developer Edition',
    namespacePrefix: null,
    instanceUrl,
    loginUrl: instanceUrl,
    accessToken
  });
  await state.orgs.write(username);
}

export async function openConnection(username: string): Promise<Connection> {
  return Connection.create({ authInfo: await AuthInfo.create({ username }) });
}

/** The JSON body of a Salesforce error, as REST returns it. */
export function salesforceError(errorCode: string, message: string, status = 400): DoubleResponse {
  return { status, body: [{ message, errorCode }] };
}
