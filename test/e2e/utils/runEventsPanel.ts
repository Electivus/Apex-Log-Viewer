import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveDevHubConfig, salesforceChildEnv, validateDevHubJwt } from '../../../scripts/devhub-auth.js';
import { EVENTS_ORG_ALIAS, eventsOrgConfigured } from './eventsOrg';
import { runSfJson } from './sfCli';
import { ensureScratchOrg, type ScratchOrgResult } from './scratchOrg';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EVENTS_POOL = 'alv-events-panel-1551';
const ARTIFACTS = path.join(ROOT, 'output', 'playwright', 'events-panel');
const REPORT = path.join(ARTIFACTS, 'events-panel-report.json');

async function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${args[0]} exited with ${code ?? signal}.`);
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  process.env.ALV_E2E_REQUIRE_EVENTS_ORG = '1';

  const testEnv = salesforceChildEnv(process.env, {
    PLAYWRIGHT_JSON_OUTPUT_FILE: REPORT,
    PLAYWRIGHT_WORKERS: '1',
    PLAYWRIGHT_RETRIES: '0',
    PLAYWRIGHT_SHARD: '',
    PLAYWRIGHT_SHUFFLE: ''
  });
  let scratch: ScratchOrgResult | undefined;
  let prepared = false;
  let passed = false;
  try {
    console.log('::group::Prepare dedicated events scratch org');
    try {
      if (process.env.SF_SCRATCH_POOL_NAME?.trim().toLowerCase() === EVENTS_POOL) {
        throw new Error('The Custom Logs panel requires a separate events scratch-org pool.');
      }
      process.env.SF_SCRATCH_POOL_NAME = EVENTS_POOL;
      process.env.SF_SCRATCH_STRATEGY = 'pool';
      const config = resolveDevHubConfig();
      if (config?.mode !== 'jwt') throw new Error('The events panel requires Dev Hub JWT.');
      validateDevHubJwt(config);
      const definition = JSON.parse(await readFile(path.join(ROOT, 'config/project-scratch-def.events.json'), 'utf8'));
      scratch = await ensureScratchOrg({ poolDefinition: definition });
      const { result } = await runSfJson(['org', 'display', '--target-org', scratch.scratchAlias]);
      if (typeof result?.username !== 'string' || !result.username.includes('@')) {
        throw new Error('The events pool lease did not provide an authenticated scratch org.');
      }
      await runSfJson(['alias', 'set', `${EVENTS_ORG_ALIAS}=${result.username}`]);
      await runNode(['scripts/events-org.mjs', 'prepare'], testEnv);
      eventsOrgConfigured();
      scratch.assertLeaseHealthy?.();
      prepared = true;
      console.log(`Dedicated events scratch org verified in pool ${EVENTS_POOL}, slot ${scratch.slotKey}.`);
    } catch (error) {
      throw new Error(
        `Events scratch org preparation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      console.log('::endgroup::');
    }

    await mkdir(ARTIFACTS, { recursive: true });
    await rm(REPORT, { force: true });
    await runNode(
      [
        'scripts/run-playwright-e2e.js',
        'specs/customLogEventsPanel.e2e.spec.ts',
        '--reporter=list,json',
        '--output',
        path.join(ARTIFACTS, 'test-results')
      ],
      testEnv
    );
    scratch.assertLeaseHealthy?.();
    const { stats } = JSON.parse(await readFile(REPORT, 'utf8'));
    if (stats?.expected !== 2 || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) {
      throw new Error(
        `The Custom Logs panel requires two passing tests without skips. Stats: ${JSON.stringify(stats)}`
      );
    }
    console.log('Custom Logs panel: two tests passed, zero skipped.');
    passed = true;
  } finally {
    await scratch?.cleanup({ success: passed, needsRecreate: prepared ? undefined : true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
