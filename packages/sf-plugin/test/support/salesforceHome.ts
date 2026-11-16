import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import { StateAggregator } from '@salesforce/core';

import { ORG_ID } from '../../../core/test/support/salesforceDouble.ts';

/**
 * Points `@salesforce/core` at a throwaway home and working directory, so saved auth never touches the
 * developer's. Call it once at the top of a test file, before the first SDK call: `node --test` runs
 * each file in its own process. Returns the home.
 */
export function isolateSalesforceHome(): string {
  const originalCwd = process.cwd();
  const sfHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alv-sf-home-')));
  process.env.HOME = sfHome;
  process.env.USERPROFILE = sfHome;
  process.env.SF_USE_GENERIC_UNIX_KEYCHAIN = 'true';
  process.env.SF_DISABLE_LOG_FILE = 'true';
  process.env.SF_DISABLE_DNS_CHECK = 'true';
  process.env.SFDX_IGNORE_API_VERSION_CACHE = 'true';
  delete process.env.SF_TARGET_ORG;
  delete process.env.SF_TARGET_DEV_HUB;
  process.chdir(sfHome);
  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(sfHome, { recursive: true, force: true });
  });
  return sfHome;
}

export type SfOrgAuth = {
  accessToken?: string;
  refreshToken?: string;
  alias?: string;
  isScratch?: boolean;
  /** Where `sf` asks for a new access token; the instance by default. */
  loginUrl?: string;
};

/** Saves `username` in the isolated home the way `sf org login` does, for the plugin to read through `@salesforce/core`. */
export async function saveSfOrgAuth(username: string, instanceUrl: string, auth: SfOrgAuth = {}): Promise<void> {
  const { accessToken = 'token-double', refreshToken, alias, isScratch, loginUrl = instanceUrl } = auth;
  const state = await StateAggregator.getInstance();
  state.orgs.set(username, {
    username,
    orgId: ORG_ID,
    orgEdition: 'Developer Edition',
    namespacePrefix: null,
    instanceUrl,
    loginUrl,
    accessToken,
    ...(refreshToken ? { refreshToken, clientId: 'PlatformCLI' } : {}),
    ...(isScratch ? { isScratch } : {})
  });
  await state.orgs.write(username);
  if (alias) await state.aliases.setAndSave(alias, username);
}
