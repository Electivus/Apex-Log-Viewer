import { AuthInfo, ConfigAggregator, Connection, OrgConfigProperties, StateAggregator } from '@salesforce/core';

import { usableAccessToken, type OrgAuthSource, type OrgSession, type SourceOrg } from '@alv/core';

const RENEWAL_API_VERSION = '63.0';

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
        const alias = asString(state.aliases.get(username));
        const names = [username, alias];
        return [
          {
            username,
            alias,
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
      const authInfo = await AuthInfo.create({ username: org.username });
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
