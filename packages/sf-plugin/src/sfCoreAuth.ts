import { promises as fs } from 'node:fs';

import {
  AuthInfo,
  ConfigAggregator,
  Connection,
  OrgConfigProperties,
  StateAggregator,
  type AuthFields
} from '@salesforce/core';

import { usableAccessToken, type OrgAuthSource, type OrgSession, type SourceOrg } from '@alv/core';

const RENEWAL_API_VERSION = '63.0';

/**
 * An `AuthInfo` whose saves are not lost to an auth file dated after them by a lagging stamp clock.
 *
 * `@salesforce/core` merges the auth file into memory on each save and keeps the file's value of a field when the
 * file's mtime is later than the stamp of the in-memory change. 9.2 stamps with `performance.timeOrigin +
 * performance.now()`, which is set from the wall clock at process start and then counts on its own, so it can trail
 * the wall clock that dates the file (#1449). A renewal whose save loses that comparison hands jsforce the expired
 * token and keeps the refresh token that rotation has already invalidated, so the org's login is gone.
 *
 * Before a save, a file the wall clock dates before the latest change, yet after that change's stamp, is redated just
 * below the stamp. A file written after the change keeps its mtime and wins the merge, as it would without this class.
 */
class PersistentAuthInfo extends AuthInfo {
  #change: { stampFloorMs: number; wallMs: number } | undefined;

  public override update(authData?: AuthFields): AuthInfo {
    if (authData) {
      // 9.2 stamps with the performance clock and 9.4 with Date.now(); the change's stamp is past this floor on both.
      // Date.now() drops the fraction of a millisecond, so a file dated within the same millisecond counts as older.
      const now = Date.now();
      const stampFloorMs =
        Math.min(performance.timeOrigin + performance.now(), now, this.#change?.stampFloorMs ?? now) - 1;
      this.#change = { stampFloorMs, wallMs: now + 1 };
    }
    return super.update(authData);
  }

  public override async save(authData?: AuthFields): Promise<AuthInfo> {
    if (authData) this.update(authData);
    const change = this.#change;
    this.#change = undefined;
    if (change) await redateOlderFile((await StateAggregator.getInstance()).orgs.getPath(this.getUsername()), change);
    return super.save();
  }
}

async function redateOlderFile(file: string, change: { stampFloorMs: number; wallMs: number }): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stats.mtimeMs > change.stampFloorMs && stats.mtimeMs <= change.wallMs) {
    await fs.utimes(file, stats.atime, change.stampFloorMs / 1000);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sessionOf(
  fields: { accessToken?: unknown; instanceUrl?: unknown; orgId?: unknown },
  org: SourceOrg
): OrgSession {
  const accessToken = usableAccessToken(fields.accessToken);
  const instanceUrl = asString(fields.instanceUrl) ?? org.instanceUrl;
  if (!accessToken || !instanceUrl) {
    throw new Error(`No usable Salesforce auth is stored for ${org.username}. Run "sf org login web" to log in.`);
  }
  return { accessToken, instanceUrl, orgId: asString(fields.orgId) ?? org.orgId };
}

/**
 * Salesforce auth for commands that run inside `sf`: the library `sf` itself loads reads the auth
 * files, and only a rejected session is refreshed, which `sf` saves as any of its commands would.
 * The working directory's project names the default org, as for every `sf` command.
 */
export function createSfCoreAuthSource(): OrgAuthSource {
  return {
    async listOrgs() {
      const state = await StateAggregator.getInstance();
      const orgs = await state.orgs.readAll(false);
      const config = await ConfigAggregator.create();
      const defaultOrg = asString(config.getPropertyValue<string>(OrgConfigProperties.TARGET_ORG));
      const defaultDevHub = asString(config.getPropertyValue<string>(OrgConfigProperties.TARGET_DEV_HUB));
      return orgs.flatMap(fields => {
        const username = asString(fields.username);
        if (!username) return [];
        const aliases = state.aliases.getAll(username);
        const names = [username, ...aliases];
        return [
          {
            username,
            alias: aliases[0],
            aliases,
            orgId: asString(fields.orgId),
            instanceUrl: asString(fields.instanceUrl),
            isScratchOrg: Boolean(fields.isScratch),
            isDefaultUsername: Boolean(defaultOrg && names.includes(defaultOrg)),
            isDefaultDevHubUsername: Boolean(defaultDevHub && names.includes(defaultDevHub))
          }
        ];
      });
    },
    async session(org, reason) {
      const authInfo = await PersistentAuthInfo.create({ username: org.username });
      if (reason === 'first-use') return sessionOf(authInfo.getFields(true), org);
      // An explicit version keeps `Connection.create` from looking up and saving the org's API version.
      const connection = await Connection.create({ authInfo, connectionOptions: { version: RENEWAL_API_VERSION } });
      await connection.refreshAuth();
      return sessionOf(
        { accessToken: connection.accessToken, instanceUrl: connection.instanceUrl, orgId: authInfo.getFields().orgId },
        org
      );
    }
  };
}
