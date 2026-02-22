import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runSfJson } from './sfCli';

type ScratchOrgResult = {
  devHubAlias: string;
  scratchAlias: string;
  created: boolean;
  cleanup: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function envFlag(name: string): boolean {
  const value = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true';
}

async function tryOrgDisplay(alias: string): Promise<boolean> {
  try {
    await runSfJson(['org', 'display', '-o', alias]);
    return true;
  } catch {
    return false;
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
  const preferredAliases = ['ElectivusDevHub', 'DevHubElectivus', 'InsuranceOrgTrialCreme6DevHub'];
  for (const alias of preferredAliases) {
    if (await tryOrgDisplay(alias)) {
      return alias;
    }
  }
  return 'DevHub';
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

async function waitForScratchOrgReady(targetOrg: string): Promise<void> {
  const timeoutMs = Math.max(30_000, Number(process.env.SF_SCRATCH_READY_TIMEOUT_MS || 240_000) || 240_000);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
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
      return;
    } catch (error) {
      lastError = error;
      await sleep(5_000);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || '');
  throw new Error(`Scratch org '${targetOrg}' was not ready after ${timeoutMs}ms. ${detail}`.trim());
}

export async function ensureScratchOrg(): Promise<ScratchOrgResult> {
  const devHubAlias = await resolveDefaultDevHubAlias();
  await ensureDevHubAuth(devHubAlias);

  const scratchAlias = String(process.env.SF_SCRATCH_ALIAS || 'ALV_E2E_Scratch').trim();
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1) || 1;
  const keep = envFlag('SF_TEST_KEEP_ORG');

  // Reuse existing scratch org when possible to make local runs faster.
  const alreadyExists = await tryOrgDisplay(scratchAlias);
  if (alreadyExists) {
    await waitForScratchOrgReady(scratchAlias);
    return {
      devHubAlias,
      scratchAlias,
      created: false,
      cleanup: async () => {}
    };
  }

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
    await runSfJson(
      [
        'org',
        'create',
        'scratch',
        '--target-dev-hub',
        devHubAlias,
        '--alias',
        scratchAlias,
        '--definition-file',
        defFile,
        '--duration-days',
        String(durationDays),
        '--wait',
        '15'
      ],
      { cwd: tmp }
    );
  } catch (_e) {
    await cleanup();
    const msg = _e instanceof Error ? _e.message : String(_e);
    throw new Error(`Failed to create scratch org '${scratchAlias}': ${msg}`);
  }

  await waitForScratchOrgReady(scratchAlias);

  return {
    devHubAlias,
    scratchAlias,
    created: true,
    cleanup
  };
}
