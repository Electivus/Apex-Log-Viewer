import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';

import {
  AlvError,
  usableAccessToken,
  type OrgAuthSource,
  type OrgSession,
  type SalesforceProxySettings,
  type SourceOrg
} from '@alv/core';

import { CLI_TIMEOUT_MS, execCommand } from './exec';
import { getLoginShellEnv } from './path';
import { readProxySettings } from './proxy';

/** Startup work `sf` can skip when it only answers a query. A value the user set wins. */
const QUIET_SF_ENV: Readonly<Record<string, string>> = {
  SF_DISABLE_LOG_FILE: 'true',
  SF_SKIP_NEW_VERSION_CHECK: 'true',
  SF_DISABLE_AUTOUPDATE: 'true'
};

type JsonObject = Record<string, unknown>;

/** Which command of the installed CLI prints a usable token, learned from its behaviour. */
type TokenCommand = 'show-access-token' | 'display';

type SfRun = { kind: 'ok'; result: unknown } | { kind: 'command-missing' };

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.keys(env).some(key => key.toUpperCase() === name && env[key] !== undefined);
}

function replaceEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
  env[name] = value;
}

export function sfEnvironment(base: NodeJS.ProcessEnv, proxy: SalesforceProxySettings = {}): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(QUIET_SF_ENV)) {
    if (!hasEnv(env, name)) env[name] = value;
  }
  // `http.proxy` routes the extension's own Salesforce requests, so the token renewals `sf` makes take it too.
  const proxyUrl = proxy.proxyUrl?.trim();
  if (proxyUrl) {
    replaceEnv(env, 'HTTPS_PROXY', proxyUrl);
    replaceEnv(env, 'HTTP_PROXY', proxyUrl);
    if (proxy.noProxy?.length) replaceEnv(env, 'NO_PROXY', proxy.noProxy.join(','));
  }
  return env;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** sf colors its JSON when the environment forces color, as Playwright's FORCE_COLOR does. */
function parseJson(text: string): JsonObject | undefined {
  const raw = stripVTControlCharacters(String(text || '')).trim();
  if (!raw) return undefined;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

/** `sf org list auth --json`, read through an allowlist: the token field it may carry is never kept. */
export function parseOrgListAuth(result: unknown): SourceOrg[] {
  if (!Array.isArray(result)) return [];
  const orgs: SourceOrg[] = [];
  for (const entry of result as JsonObject[]) {
    const username = asString(entry?.username);
    if (!username) continue;
    const configs = Array.isArray(entry.configs) ? entry.configs.map(String) : [];
    // sf joins every alias of the org with commas.
    const aliases = (asString(entry.alias) ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    orgs.push({
      username,
      alias: aliases[0],
      aliases,
      orgId: asString(entry.orgId),
      instanceUrl: asString(entry.instanceUrl),
      isScratchOrg: entry.isScratchOrg === true,
      isDefaultUsername: configs.includes('target-org') || configs.includes('defaultusername'),
      isDefaultDevHubUsername: configs.includes('target-dev-hub') || configs.includes('defaultdevhubusername')
    });
  }
  return orgs;
}

/**
 * Salesforce auth through the `sf` CLI, the only program that reads, refreshes and writes the auth
 * files. Every call starts one `sf` process; core keeps what it returns in memory.
 */
export function createSfCliAuthSource(options: { projectDir: () => string | undefined }): OrgAuthSource {
  let tokenCommand: TokenCommand | undefined;

  const runSf = async (args: string[], signal?: AbortSignal): Promise<SfRun> => {
    const env = sfEnvironment((await getLoginShellEnv()) ?? process.env, readProxySettings());
    const program = asString(env.ALV_SF_BIN_PATH) ?? 'sf';
    const cwd = options.projectDir() ?? os.homedir();
    try {
      const { stdout } = await execCommand(program, [...args, '--json'], env, CLI_TIMEOUT_MS, signal, cwd);
      const parsed = parseJson(stdout);
      if (!parsed) throw new AlvError('SF_CLI_FAILED', `sf ${args.slice(0, 3).join(' ')} printed no JSON.`);
      return { kind: 'ok', result: parsed.result };
    } catch (error) {
      if (error instanceof AlvError) throw error;
      const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
      if (failure.code === 'ENOENT') {
        throw new AlvError(
          'SF_CLI_NOT_FOUND',
          'The Salesforce CLI (sf) was not found. Install it, or set ALV_SF_BIN_PATH to its path, then reload VS Code.',
          { cause: error }
        );
      }
      if (failure.code === 127 || /is not a sf command/i.test(String(failure.stderr ?? ''))) {
        return { kind: 'command-missing' };
      }
      const reported = parseJson(String(failure.stdout ?? '')) ?? parseJson(String(failure.stderr ?? ''));
      const message = asString(reported?.message) ?? asString(failure.message) ?? 'unknown error';
      throw new AlvError('SF_CLI_FAILED', message, { cause: error });
    }
  };

  const tokenFromShowAccessToken = async (org: SourceOrg, signal?: AbortSignal): Promise<OrgSession | undefined> => {
    const run = await runSf(['org', 'auth', 'show-access-token', '--target-org', org.username, '--no-prompt'], signal);
    if (run.kind === 'command-missing') return undefined;
    const accessToken = usableAccessToken((run.result as JsonObject | undefined)?.accessToken);
    if (!accessToken) throw new AlvError('SF_CLI_FAILED', 'sf org auth show-access-token printed no token.');
    if (!org.instanceUrl) {
      throw new AlvError('SF_CLI_FAILED', `The Salesforce CLI lists no instance URL for ${org.username}.`);
    }
    return { accessToken, instanceUrl: org.instanceUrl, orgId: org.orgId };
  };

  /** Older CLIs print the token in `org display`; newer ones print a placeholder there. */
  const tokenFromDisplay = async (org: SourceOrg, signal?: AbortSignal): Promise<OrgSession | 'redacted'> => {
    const run = await runSf(['org', 'display', '--target-org', org.username], signal);
    const result = (run.kind === 'ok' ? run.result : undefined) as JsonObject | undefined;
    const accessToken = usableAccessToken(result?.accessToken);
    const instanceUrl = asString(result?.instanceUrl) ?? org.instanceUrl;
    if (!accessToken || !instanceUrl) return 'redacted';
    return { accessToken, instanceUrl, orgId: asString(result?.id) ?? org.orgId };
  };

  return {
    async listOrgs(signal) {
      const run = await runSf(['org', 'list', 'auth'], signal);
      return run.kind === 'ok' ? parseOrgListAuth(run.result) : [];
    },
    async session(org, _reason, signal) {
      // Both reasons run the same command: `sf` checks the stored token and refreshes it only when the org refuses it.
      if (tokenCommand !== 'display') {
        const session = await tokenFromShowAccessToken(org, signal);
        if (session) {
          tokenCommand = 'show-access-token';
          return session;
        }
      }
      const learned = tokenCommand === 'display';
      tokenCommand = 'display';
      const session = await tokenFromDisplay(org, signal);
      if (session !== 'redacted') return session;
      // A placeholder after an earlier missing command means the CLI was updated since: ask the new command.
      const updated = learned ? await tokenFromShowAccessToken(org, signal) : undefined;
      if (updated) {
        tokenCommand = 'show-access-token';
        return updated;
      }
      throw new AlvError(
        'SF_CLI_UNSUPPORTED',
        'This Salesforce CLI hides the access token in "sf org display" and has no "sf org auth show-access-token". Update the Salesforce CLI.'
      );
    }
  };
}
