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

  // Local convenience: prefer the project team's DevHub alias if present.
  const preferred = 'InsuranceOrgTrialCreme6DevHub';
  if (await tryOrgDisplay(preferred)) {
    return preferred;
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

export async function ensureScratchOrg(): Promise<ScratchOrgResult> {
  const devHubAlias = await resolveDefaultDevHubAlias();
  await ensureDevHubAuth(devHubAlias);

  const scratchAlias = String(process.env.SF_SCRATCH_ALIAS || 'ALV_E2E_Scratch').trim();
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1) || 1;
  const keep = envFlag('SF_TEST_KEEP_ORG');

  // Reuse existing scratch org when possible to make local runs faster.
  const alreadyExists = await tryOrgDisplay(scratchAlias);
  if (alreadyExists) {
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

  return {
    devHubAlias,
    scratchAlias,
    created: true,
    cleanup
  };
}
