import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runSfJson } from './sfCli';
import { timeE2eStep } from './timing';
import { assertToolingReady, primeOrgAuthCache, type OrgAuth } from './tooling';

type ScratchOrgResult = {
  devHubAlias: string;
  scratchAlias: string;
  created: boolean;
  cleanup: () => Promise<void>;
};

const LOCAL_DEV_HUB_FALLBACK_ALIASES = [
  'DevHubElectivus',
  'DevHub',
  'ElectivusDevHub',
  'InsuranceOrgTrialCreme6DevHub'
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function envFlag(name: string): boolean {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true';
}

type OrgDisplaySummary = {
  status?: string;
  expirationDate?: string;
  accessToken?: string;
  instanceUrl?: string;
  username?: string;
};

function toOrgAuth(display: OrgDisplaySummary | undefined): OrgAuth | undefined {
  if (!display?.accessToken || !display.instanceUrl) {
    return undefined;
  }
  return {
    accessToken: display.accessToken,
    instanceUrl: display.instanceUrl,
    username: display.username,
    apiVersion: String(process.env.SF_TEST_API_VERSION || process.env.SF_API_VERSION || '60.0')
  };
}

async function getOrgDisplay(alias: string): Promise<OrgDisplaySummary | undefined> {
  try {
    const result = await runSfJson(['org', 'display', '-o', alias]);
    const org = result?.result ?? {};
    return {
      status: typeof org.status === 'string' ? org.status.trim() : undefined,
      expirationDate: typeof org.expirationDate === 'string' ? org.expirationDate.trim() : undefined,
      accessToken: typeof org.accessToken === 'string' ? org.accessToken : undefined,
      instanceUrl:
        typeof org.instanceUrl === 'string'
          ? org.instanceUrl
          : typeof org.instance_url === 'string'
            ? org.instance_url
            : typeof org.loginUrl === 'string'
              ? org.loginUrl
              : undefined,
      username: typeof org.username === 'string' ? org.username : undefined
    };
  } catch (error) {
    console.warn(
      `[e2e] sf org display failed for alias '${alias}': ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function tryOrgDisplay(alias: string): Promise<boolean> {
  return Boolean(await getOrgDisplay(alias));
}

function isReusableScratchOrg(display: OrgDisplaySummary | undefined, nowMs = Date.now()): boolean {
  if (!display) {
    return false;
  }

  const normalizedStatus = String(display.status || '')
    .trim()
    .toLowerCase();
  if (normalizedStatus === 'deleted' || normalizedStatus === 'expired') {
    return false;
  }

  if (display.expirationDate) {
    const expiresAt = Date.parse(display.expirationDate);
    if (Number.isFinite(expiresAt) && expiresAt < nowMs) {
      return false;
    }
  }

  return true;
}

async function clearStaleScratchOrg(alias: string): Promise<void> {
  try {
    await runSfJson(['org', 'logout', '--target-org', alias, '--no-prompt']);
  } catch (error) {
    console.warn(
      `[e2e] sf org logout failed for stale alias '${alias}': ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    await runSfJson(['alias', 'unset', alias]);
  } catch (error) {
    console.warn(
      `[e2e] sf alias unset failed for stale alias '${alias}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function resolveDefaultDevHubAlias(): Promise<string> {
  if (process.env.SF_DEVHUB_ALIAS) {
    return String(process.env.SF_DEVHUB_ALIAS).trim();
  }
  if (process.env.SF_DEVHUB_AUTH_URL) {
    return 'DevHub';
  }

  // Local convenience: prefer the current team DevHub alias when available.
  // Keep legacy aliases as fallbacks for older local setups.
  for (const alias of LOCAL_DEV_HUB_FALLBACK_ALIASES) {
    if (await tryOrgDisplay(alias)) {
      return alias;
    }
  }
  return 'DevHub';
}

async function getFallbackDevHubAliases(primaryAlias: string): Promise<string[]> {
  const normalizedPrimary = String(primaryAlias || '').trim().toLowerCase();
  const candidates = Array.from(
    new Set(
      LOCAL_DEV_HUB_FALLBACK_ALIASES.map(alias => String(alias || '').trim()).filter(Boolean).filter(
        alias => alias.toLowerCase() !== normalizedPrimary
      )
    )
  );

  const available: string[] = [];
  for (const alias of candidates) {
    if (await tryOrgDisplay(alias)) {
      available.push(alias);
    }
  }
  return available;
}

function shouldKeepScratchOrg(): boolean {
  if (process.env.SF_TEST_KEEP_ORG !== undefined) {
    return envFlag('SF_TEST_KEEP_ORG');
  }
  return !envFlag('CI');
}

function isScratchOrgSignupLimitError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return message.includes('limit_exceeded') && message.includes('scratch org signup limit');
}

async function createScratchOrgWithFallback(options: {
  devHubAlias: string;
  scratchAlias: string;
  definitionFile: string;
  durationDays: number;
  cwd: string;
}): Promise<string> {
  const fallbackAliases = await getFallbackDevHubAliases(options.devHubAlias);
  const candidates = [options.devHubAlias, ...fallbackAliases];
  let lastError: unknown;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    try {
      await runSfJson(
        [
          'org',
          'create',
          'scratch',
          '--target-dev-hub',
          candidate,
          '--alias',
          options.scratchAlias,
          '--definition-file',
          options.definitionFile,
          '--duration-days',
          String(options.durationDays),
          '--wait',
          '15'
        ],
        { cwd: options.cwd }
      );
      return candidate;
    } catch (error) {
      lastError = error;
      const hasNextCandidate = index + 1 < candidates.length;
      if (!hasNextCandidate || !isScratchOrgSignupLimitError(error)) {
        throw error;
      }
      const nextCandidate = candidates[index + 1]!;
      console.warn(
        `[e2e] scratch org signup limit reached for Dev Hub '${candidate}'; trying fallback '${nextCandidate}'.`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown scratch org creation failure'));
}

async function ensureDevHubAuth(devHubAlias: string): Promise<void> {
  const authUrl = String(process.env.SF_DEVHUB_AUTH_URL || '').trim();
  if (!authUrl) {
    // Assume already authenticated locally; surface a helpful error if not.
    const ok = await tryOrgDisplay(devHubAlias);
    if (!ok) {
      throw new Error(
        `Dev Hub not found. Set SF_DEVHUB_ALIAS (current: '${devHubAlias}') or provide SF_DEVHUB_AUTH_URL to authenticate in CI.`
      );
    }
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'alv-devhub-'));
  const filePath = path.join(dir, 'devhub.sfdxurl');
  await writeFile(filePath, authUrl, 'utf8');
  try {
    await runSfJson(['org', 'login', 'sfdx-url', '--sfdx-url-file', filePath, '--alias', devHubAlias]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitForScratchOrgReady(targetOrg: string, auth?: OrgAuth): Promise<void> {
  const timeoutMs = Math.max(30_000, Number(process.env.SF_SCRATCH_READY_TIMEOUT_MS || 240_000) || 240_000);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (auth) {
        await assertToolingReady(auth, { timeoutMs: 30_000 });
      } else {
        // Some scratch orgs return interstitial HTML ("Stay tuned...") for a short
        // period after creation. Poll a lightweight Tooling API query until it
        // returns JSON successfully.
        await runSfJson(
          [
            'data',
            'query',
            '--query',
            'SELECT Id FROM DebugLevel LIMIT 1',
            '--use-tooling-api',
            '--target-org',
            targetOrg,
          ],
          { timeoutMs: 30_000 }
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await sleep(auth ? 1_000 : 5_000);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || '');
  throw new Error(`Scratch org '${targetOrg}' was not ready after ${timeoutMs}ms. ${detail}`.trim());
}

export async function ensureScratchOrg(): Promise<ScratchOrgResult> {
  return await timeE2eStep('scratch.ensure', async () => {
    let devHubAlias = await resolveDefaultDevHubAlias();
    const scratchAlias = String(process.env.SF_SCRATCH_ALIAS || 'ALV_E2E_Scratch').trim();
    const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1) || 1;
    const keep = shouldKeepScratchOrg();

    // Reuse existing scratch org when possible to make local runs faster.
    const existingScratch = await getOrgDisplay(scratchAlias);
    if (isReusableScratchOrg(existingScratch)) {
      const auth = toOrgAuth(existingScratch);
      if (auth) {
        primeOrgAuthCache(scratchAlias, auth);
      }
      await waitForScratchOrgReady(scratchAlias, auth);
      return {
        devHubAlias,
        scratchAlias,
        created: false,
        cleanup: async () => {}
      };
    }
    if (existingScratch) {
      console.warn(
        `[e2e] scratch alias '${scratchAlias}' points to a stale org (status='${existingScratch.status || 'unknown'}', expiration='${existingScratch.expirationDate || 'unknown'}'); recreating.`
      );
      await clearStaleScratchOrg(scratchAlias);
    }

    await ensureDevHubAuth(devHubAlias);

    const tmp = await mkdtemp(path.join(tmpdir(), 'alv-scratch-'));
    const defFile = path.join(tmp, 'project-scratch-def.json');
    const projectFile = path.join(tmp, 'sfdx-project.json');
    const def = {
      orgName: 'apex-log-viewer-e2e',
      edition: 'Developer',
      hasSampleData: false
    };
    await writeFile(defFile, JSON.stringify(def), 'utf8');

    const cleanup = async () => {
      try {
        if (!keep) {
          try {
            await runSfJson(['org', 'delete', 'scratch', '-o', scratchAlias, '--no-prompt'], { cwd: tmp });
          } catch {
            // Best-effort cleanup.
          }
        }
      } catch {
        // Best-effort cleanup.
      } finally {
        try {
          await rm(tmp, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    };

    // `sf org create scratch` requires a Salesforce DX project. This repo is not
    // itself a Salesforce project, so create a minimal temporary project context.
    await mkdir(path.join(tmp, 'force-app'), { recursive: true });
    await writeFile(
      projectFile,
      JSON.stringify(
        {
          packageDirectories: [{ path: 'force-app', default: true }],
          name: 'apex-log-viewer-e2e',
          namespace: '',
          sfdcLoginUrl: 'https://login.salesforce.com',
          sourceApiVersion: '61.0'
        },
        null,
        2
      ),
      'utf8'
    );

    try {
      devHubAlias = await createScratchOrgWithFallback({
        devHubAlias,
        scratchAlias,
        definitionFile: defFile,
        durationDays,
        cwd: tmp
      });
    } catch (_e) {
      await cleanup();
      const msg = _e instanceof Error ? _e.message : String(_e);
      throw new Error(`Failed to create scratch org '${scratchAlias}': ${msg}`);
    }

    const auth = toOrgAuth(await getOrgDisplay(scratchAlias));
    if (auth) {
      primeOrgAuthCache(scratchAlias, auth);
    }
    await waitForScratchOrgReady(scratchAlias, auth);

    if (!auth) {
      const refreshedScratch = await getOrgDisplay(scratchAlias);
      const refreshedAuth = toOrgAuth(refreshedScratch);
      if (refreshedAuth) {
        primeOrgAuthCache(scratchAlias, refreshedAuth);
      }
    }

    return {
      devHubAlias,
      scratchAlias,
      created: true,
      cleanup
    };
  });
}
