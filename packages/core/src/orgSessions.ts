import { Connection } from '@jsforce/jsforce-node';

import type { OrgListItem } from './contracts.js';
import { AlvError, awaitWithAbort, throwIfAborted } from './errors.js';

/** An org with stored Salesforce CLI auth, as its auth source lists it. Carries no secret. */
export type SourceOrg = OrgListItem & { orgId?: string };

/** What requests to one org need. It lives in memory only and is never written anywhere. */
export type OrgSession = { accessToken: string; instanceUrl: string; orgId?: string };

/**
 * Where core gets Salesforce auth. The extension's source asks the `sf` CLI; the plugin's reads the
 * library `sf` itself runs, inside the `sf` process. Core never opens a Salesforce auth file.
 */
export type OrgAuthSource = {
  /** Every org with stored auth, read anew on each call. `isDefaultUsername` follows the project's config. */
  listOrgs(signal?: AbortSignal): Promise<SourceOrg[]>;
  /**
   * A session for `org`. `rejected` follows a session Salesforce refused, so the source may renew it;
   * what renewing changes on disk the source writes, never core.
   */
  session(org: SourceOrg, reason: 'first-use' | 'rejected', signal?: AbortSignal): Promise<OrgSession>;
};

export type ResolvedOrg = { requested: string; org: SourceOrg; source: 'username' | 'alias' };

const REDACTED_TOKEN = /^\[?redacted\]?|use ['"]?sf org auth/i;

/** A token a request can send: newer CLIs print a placeholder where older ones printed the token. */
export function usableAccessToken(value: unknown): string | undefined {
  const token = typeof value === 'string' ? value.trim() : '';
  return token && !REDACTED_TOKEN.test(token) ? token : undefined;
}

export function authRequiredError(username: string): AlvError {
  return new AlvError(
    'AUTH_REQUIRED',
    `Salesforce rejected the session of ${username} and the Salesforce CLI has no other. Run "sf org login web" to log in again.`
  );
}

/** The org `targetOrg` names among `orgs`: a username (any case), an alias, or the project's default when absent. */
export function resolveTargetOrg(orgs: readonly SourceOrg[], targetOrg: string | undefined): ResolvedOrg | undefined {
  const requested = targetOrg?.trim();
  if (!requested) {
    const org = orgs.find(candidate => candidate.isDefaultUsername);
    return org && { requested: org.alias ?? org.username, org, source: org.alias ? 'alias' : 'username' };
  }
  const byUsername = orgs.find(org => org.username.toLowerCase() === requested.toLowerCase());
  if (byUsername) return { requested, org: byUsername, source: 'username' };
  const byAlias = orgs.find(org => org.alias === requested);
  return byAlias && { requested, org: byAlias, source: 'alias' };
}

export type OrgSessions = {
  /** The listed orgs, memoized. `fresh` asks the source again. */
  orgs(options?: { fresh?: boolean; signal?: AbortSignal }): Promise<SourceOrg[]>;
  /** Resolves through the memo, listing again once on a miss: a login made since the last list counts. */
  resolve(targetOrg: string | undefined, signal?: AbortSignal): Promise<ResolvedOrg>;
  /** The session in memory, or one first-use fetch shared by every concurrent caller. */
  current(org: SourceOrg, signal?: AbortSignal): Promise<OrgSession>;
  /**
   * Salesforce refused `rejectedToken`. A newer session already in memory answers without asking the
   * source; a renewal in flight is joined; otherwise the source renews once. A source that hands back
   * the refused token ends with AUTH_REQUIRED and forgets the org's session.
   */
  renew(org: SourceOrg, rejectedToken: string, signal?: AbortSignal): Promise<OrgSession>;
  clear(): void;
};

type SessionCell = { pending: Promise<OrgSession>; session?: OrgSession };

export function createOrgSessions(source: OrgAuthSource): OrgSessions {
  let listed: Promise<SourceOrg[]> | undefined;
  const cells = new Map<string, SessionCell>();

  const list = (fresh: boolean): Promise<SourceOrg[]> => {
    if (listed && !fresh) return listed;
    const pending = source.listOrgs();
    listed = pending;
    pending.catch(() => {
      if (listed === pending) listed = undefined;
    });
    return pending;
  };

  const fetchSession = (org: SourceOrg, reason: 'first-use' | 'rejected', rejectedToken?: string): SessionCell => {
    const cell: SessionCell = {
      pending: source.session(org, reason).then(session => {
        if (rejectedToken !== undefined && session.accessToken === rejectedToken) throw authRequiredError(org.username);
        cell.session = session;
        return session;
      })
    };
    cells.set(org.username, cell);
    cell.pending.catch(() => {
      if (cells.get(org.username) === cell) cells.delete(org.username);
    });
    return cell;
  };

  return {
    orgs: ({ fresh = false, signal } = {}) => awaitWithAbort(list(fresh), signal),
    async resolve(targetOrg, signal) {
      const found =
        resolveTargetOrg(await awaitWithAbort(list(false), signal), targetOrg) ??
        resolveTargetOrg(await awaitWithAbort(list(true), signal), targetOrg);
      if (found) return found;
      const requested = targetOrg?.trim();
      throw new Error(
        requested
          ? `No authorization information found for ${requested}. Run "sf org login web" to log in.`
          : 'No default Salesforce org is configured. Select an org or run "sf org login web".'
      );
    },
    current(org, signal) {
      throwIfAborted(signal);
      return awaitWithAbort((cells.get(org.username) ?? fetchSession(org, 'first-use')).pending, signal);
    },
    async renew(org, rejectedToken, signal) {
      throwIfAborted(signal);
      let cell = cells.get(org.username);
      while (cell) {
        const session = cell.session ?? (await awaitWithAbort(cell.pending, signal));
        if (session.accessToken !== rejectedToken) return session;
        const latest = cells.get(org.username);
        if (latest === cell) break;
        cell = latest;
      }
      return awaitWithAbort(fetchSession(org, 'rejected', rejectedToken).pending, signal);
    },
    clear() {
      listed = undefined;
      cells.clear();
    }
  };
}

const refreshFailures = new WeakMap<Connection, unknown>();

/**
 * jsforce reports a failed renewal as a new `Error("Unable to refresh session due to: …")`. The
 * renewal's own error, such as AUTH_REQUIRED, says more.
 */
export function renewalFailureOf(connection: Connection, error: unknown): unknown {
  const original = refreshFailures.get(connection);
  return original !== undefined &&
    error instanceof Error &&
    error.message.startsWith('Unable to refresh session due to:')
    ? original
    : error;
}

/**
 * A jsforce connection holding `session` in memory. jsforce retries a request Salesforce rejects
 * (401 or INVALID_SESSION_ID) after `renew`. A renewed session refused again before any request
 * succeeded with it ends in AUTH_REQUIRED instead of another renewal.
 */
export function createSessionConnection(options: {
  username: string;
  session: OrgSession;
  version: string;
  renew(rejectedToken: string): Promise<OrgSession>;
}): Connection {
  let renewedSinceSuccess = false;
  const connection = new Connection({
    instanceUrl: options.session.instanceUrl,
    accessToken: options.session.accessToken,
    version: options.version,
    refreshFn: (conn, done) => {
      const fail = (error: unknown): void => {
        refreshFailures.set(connection, error);
        done(error instanceof Error ? error : new Error(String(error)));
      };
      if (renewedSinceSuccess) {
        fail(authRequiredError(options.username));
        return;
      }
      renewedSinceSuccess = true;
      options.renew(String(conn.accessToken ?? '')).then(next => {
        conn.instanceUrl = next.instanceUrl;
        done(null, next.accessToken);
      }, fail);
    }
  });
  const request = connection.request.bind(connection);
  connection.request = function (this: Connection, ...args: Parameters<Connection['request']>) {
    const pending = request(...args);
    pending.then(
      () => {
        renewedSinceSuccess = false;
      },
      () => undefined
    );
    return pending;
  } as Connection['request'];
  return connection;
}
