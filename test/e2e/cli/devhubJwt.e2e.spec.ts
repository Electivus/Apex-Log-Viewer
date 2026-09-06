import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { runSfJson } from '../utils/sfCli';
import { resolveDevHubConfig, salesforceChildEnv } from '../../../scripts/devhub-auth.js';

const { pretestSetup } = require('../../../scripts/run-tests.js');

// Explicit opt-in keeps this controlled direct-path proof separate from the
// production pool workflow, whose JWT cutover belongs to #1078.
for (const runner of ['typescript', 'javascript'] as const) {
  test(`direct Dev Hub JWT and independent scratch import (${runner})`, async () => {
    test.skip(process.env.ALV_DEVHUB_JWT_SMOKE !== '1', 'Requires a controlled ECA/JWT validation identity.');
    test.setTimeout(25 * 60_000);
    const originalEnv = { ...process.env };
    const config = resolveDevHubConfig();
    if (config?.mode !== 'jwt') {
      throw new Error('The direct JWT smoke requires complete JWT inputs.');
    }
    const expectedDevHubId = String(process.env.ALV_JWT_SMOKE_DEVHUB_ORG_ID || '');
    if (!/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(expectedDevHubId)) {
      throw new Error('Set ALV_JWT_SMOKE_DEVHUB_ORG_ID to the verified, authorized Dev Hub org ID.');
    }
    const root = await mkdtemp(path.join(tmpdir(), 'alv-jwt-smoke-'));
    const primaryHome = path.join(root, 'primary');
    const independentHome = path.join(root, 'independent');
    const authFile = path.join(root, 'scratch.sfdxurl');
    const scratchAlias = `ALV_JWT_${runner}_${Date.now()}`;
    let cleanup: (() => Promise<void>) | undefined;
    let jwtKeyFile: string | undefined;
    let scratchId: string | undefined;
    try {
      await mkdir(primaryHome);
      await mkdir(independentHome);
      process.env = {
        ...originalEnv,
        ...(process.platform === 'win32' ? { USERPROFILE: primaryHome } : { HOME: primaryHome }),
        CI: 'true',
        SF_SETUP_SCRATCH: '1',
        SF_SCRATCH_STRATEGY: 'single',
        SF_SCRATCH_ALIAS: scratchAlias,
        SF_TEST_KEEP_ORG: '0',
        SF_SCRATCH_DURATION: '1',
        SF_DISABLE_TELEMETRY: 'true',
        SF_AUTOUPDATE_DISABLE: 'true',
        ALV_E2E_TIMING: '0'
      };
      for (const name of [
        'SF_DEVHUB_ALIAS',
        'SF_DEVHUB_AUTH_URL',
        'SF_SCRATCH_POOL_NAME',
        'SF_TEMP_SHOW_SECRETS',
        'SF_E2E_ACCESS_TOKEN',
        'SF_E2E_INSTANCE_URL',
        'SF_E2E_TARGET_ORG_ALIAS'
      ]) {
        delete process.env[name];
      }
      const version = await runSfJson(['version']);
      expect(version.cliVersion).toBe('@salesforce/cli/2.150.6');
      const initial = await runSfJson(['org', 'list'], { cwd: primaryHome });
      expect(Object.values(initial.result).filter(Array.isArray).flat().length).toBe(0);

      if (runner === 'javascript') {
        ({ cleanup } = await pretestSetup('integration'));
      } else {
        const scratch = await ensureScratchOrg();
        expect(scratch.created).toBe(true);
        cleanup = () => scratch.cleanup();
      }

      const devHubQuery = await runSfJson([
        'data',
        'query',
        '--target-org',
        config.username,
        '--query',
        'SELECT Id FROM Organization'
      ]);
      expect(devHubQuery.result.records[0].Id === expectedDevHubId).toBe(true);
      const devHubState = JSON.parse(
        await readFile(path.join(primaryHome, '.sfdx', `${config.username}.json`), 'utf8')
      );
      expect(
        Boolean(devHubState.privateKey) && !devHubState.refreshToken && devHubState.clientId !== 'PlatformCLI'
      ).toBe(true);
      jwtKeyFile = devHubState.privateKey;

      const scratchQuery = await runSfJson([
        'data',
        'query',
        '--target-org',
        scratchAlias,
        '--query',
        'SELECT Id FROM Organization'
      ]);
      scratchId = scratchQuery.result.records[0].Id;
      expect(Boolean(scratchId) && scratchId !== expectedDevHubId).toBe(true);
      const exported = await runSfJson([
        'org',
        'auth',
        'show-sfdx-auth-url',
        '--target-org',
        scratchAlias,
        '--no-prompt'
      ]);
      // Validate through the CLI adapter and a real independent import; never
      // put an authorization value in an assertion, attachment or log.
      await writeFile(authFile, exported.result.sfdxAuthUrl, { encoding: 'utf8', mode: 0o600 });
      const independentEnv = salesforceChildEnv(
        process.env,
        process.platform === 'win32' ? { USERPROFILE: independentHome } : { HOME: independentHome }
      );
      const empty = await runSfJson(['org', 'list'], { cwd: independentHome, env: independentEnv });
      expect(Object.values(empty.result).filter(Array.isArray).flat().length).toBe(0);
      await runSfJson(['org', 'login', 'sfdx-url', '--sfdx-url-file', authFile, '--alias', 'ImportedScratch'], {
        cwd: independentHome,
        env: independentEnv
      });
      const importedQuery = await runSfJson(
        ['data', 'query', '--target-org', 'ImportedScratch', '--query', 'SELECT Id FROM Organization'],
        { cwd: independentHome, env: independentEnv }
      );
      expect(importedQuery.result.records[0].Id === scratchId).toBe(true);
      expect(process.env.SF_TEMP_SHOW_SECRETS).toBeUndefined();

      await cleanup?.();
      cleanup = undefined;
      if (config.privateKey) expect(existsSync(jwtKeyFile!)).toBe(false);
      console.info(
        JSON.stringify({
          runner,
          cliVersion: version.cliVersion,
          emptyStateJwt: true,
          devHubJwtWithoutRefreshToken: true,
          scratchApi: true,
          independentImportQuery: true,
          workflowCleanup: true
        })
      );
    } finally {
      try {
        await cleanup?.();
      } finally {
        process.env = originalEnv;
        // Both CLI homes contain credential state and must never be retained
        // as Playwright artifacts, even when validation fails.
        if (
          path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) ||
          !path.basename(root).startsWith('alv-jwt-smoke-')
        ) {
          throw new Error('Refusing cleanup outside the owned JWT smoke directory.');
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}
