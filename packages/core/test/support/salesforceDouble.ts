import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type test from 'node:test';

import { Connection } from '@jsforce/jsforce-node';

import type { OrgAuthSource, OrgSession, SourceOrg } from '../../src/index.ts';

export const ORG_ID = '00D000000000001AAA';

export type DoubleRequest = {
  method: string;
  /** Path with the `/services/data/vNN.N` prefix removed, for example `/query` or `/tooling/query`. */
  path: string;
  query: URLSearchParams;
  body: string;
  /** The access token the request carried, without its `Bearer ` prefix. */
  token: string;
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
      body: Buffer.concat(chunks).toString('utf8'),
      token: String(request.headers.authorization ?? '').replace(/^Bearer /, '')
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

/** What the Salesforce CLI has stored for an org, as a test describes it to `saveOrgAuth`. */
export type SavedOrgAuth = {
  accessToken?: string;
  /** The CLI holds a refresh token: asked for a session after a rejection, it stores and hands out this one. */
  refreshesTo?: string;
  alias?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  isScratchOrg?: boolean;
  orgId?: string;
};

type SavedOrg = SourceOrg & { instanceUrl: string; accessToken: string; refreshesTo?: string };

/** The orgs this test process has saved, by username: the CLI's auth store, in memory. */
const savedOrgs = new Map<string, SavedOrg>();

/**
 * Saves `username` the way `sf org login` would: every auth source double lists it and hands out its
 * token. Saving it again replaces what is stored, as a new login or a refresh by the CLI does.
 */
export function saveOrgAuth(username: string, instanceUrl: string, auth: string | SavedOrgAuth = {}): void {
  const {
    accessToken = 'token-double',
    orgId = ORG_ID,
    ...listed
  } = typeof auth === 'string' ? { accessToken: auth } : auth;
  savedOrgs.set(username, { ...listed, username, instanceUrl, orgId, accessToken });
}

/** Forgets `username`, as `sf org logout` does. */
export function removeOrgAuth(username: string): void {
  savedOrgs.delete(username);
}

/** The environment variable that hands the saved orgs to a child process. */
const SAVED_ORGS_VARIABLE = 'ALV_TEST_SAVED_ORGS';

/** Variables for a child process that runs core against the orgs saved so far; the child calls `loadSavedOrgs`. */
export function savedOrgsEnv(): Record<string, string> {
  return { [SAVED_ORGS_VARIABLE]: JSON.stringify([...savedOrgs.values()]) };
}

export function loadSavedOrgs(env: NodeJS.ProcessEnv = process.env): void {
  for (const org of JSON.parse(env[SAVED_ORGS_VARIABLE] ?? '[]') as SavedOrg[]) savedOrgs.set(org.username, org);
}

export type AuthSourceCall =
  { method: 'listOrgs' } | { method: 'session'; username: string; reason: 'first-use' | 'rejected' };

export type AuthSourceDouble = OrgAuthSource & {
  /** Every question core asked, oldest first. */
  readonly calls: readonly AuthSourceCall[];
  /** The reason of every session asked for `username`, oldest first. */
  sessionReasons(username: string): Array<'first-use' | 'rejected'>;
};

/**
 * The auth source a surface would hand core, over the orgs saved with `saveOrgAuth`. It answers
 * from what is stored when it is asked, the way the `sf` CLI reads its auth files on every call.
 */
export function authSourceDouble(): AuthSourceDouble {
  const calls: AuthSourceCall[] = [];
  return {
    calls,
    sessionReasons: username =>
      calls.flatMap(call => (call.method === 'session' && call.username === username ? [call.reason] : [])),
    async listOrgs() {
      calls.push({ method: 'listOrgs' });
      return [...savedOrgs.values()].map(({ accessToken: _token, refreshesTo: _refreshed, ...org }) => org);
    },
    async session(org, reason): Promise<OrgSession> {
      calls.push({ method: 'session', username: org.username, reason });
      // A real renewal runs `sf`, about a second. jsforce retries without a new renewal a request sent
      // before the last renewal finished, comparing whole milliseconds, so an instant one would not.
      if (reason === 'rejected') await new Promise(resolve => setTimeout(resolve, 5));
      let saved = savedOrgs.get(org.username);
      if (!saved) throw new Error(`No authorization information found for ${org.username}.`);
      if (reason === 'rejected' && saved.refreshesTo) {
        saved = { ...saved, accessToken: saved.refreshesTo, refreshesTo: undefined };
        savedOrgs.set(org.username, saved);
      }
      return { accessToken: saved.accessToken, instanceUrl: saved.instanceUrl, orgId: saved.orgId };
    }
  };
}

/** A jsforce connection with the saved token of `username`, as core opens one. */
export function openConnection(username: string): Connection {
  const saved = savedOrgs.get(username);
  if (!saved) throw new Error(`saveOrgAuth(${username}) first`);
  return new Connection({ instanceUrl: saved.instanceUrl, accessToken: saved.accessToken, version: '63.0' });
}

/** The JSON body of a Salesforce error, as REST returns it. */
export function salesforceError(errorCode: string, message: string, status = 400): DoubleResponse {
  return { status, body: [{ message, errorCode }] };
}
