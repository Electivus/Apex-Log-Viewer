import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { runSfJson } from '../utils/sfCli';
import { authenticateDevHub, resolveDevHubConfig, salesforceChildEnv } from '../../../scripts/devhub-auth.js';

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
    let jwtHome: string | undefined;
    let scratchId: string | undefined;
    let scratchAttempted = false;
    try {
      await mkdir(primaryHome);
      await mkdir(independentHome);
      Object.assign(process.env, {
        ...originalEnv,
        ...(process.platform === 'win32' ? { USERPROFILE: primaryHome } : { HOME: primaryHome }),
        // Contain all runner-owned temporary state inside this smoke's root.
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        CI: 'true',
        SF_SETUP_SCRATCH: '1',
        SF_SCRATCH_STRATEGY: 'single',
        SF_SCRATCH_ALIAS: scratchAlias,
        SF_TEST_KEEP_ORG: '1',
        SF_SCRATCH_DURATION: '1',
        SF_DISABLE_TELEMETRY: 'true',
        SF_AUTOUPDATE_DISABLE: 'true',
        ALV_E2E_TIMING: '0'
      });
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

      if (!config.privateKey) throw new Error('Lifecycle smoke requires the inline PEM mode.');
      const preexistingKey = path.join(primaryHome, 'preexisting.pem');
      await writeFile(preexistingKey, config.privateKey, { encoding: 'utf8', mode: 0o600 });
      await runSfJson([
        'org',
        'login',
        'jwt',
        '--client-id',
        config.clientId,
        '--username',
        config.username,
        '--instance-url',
        config.loginUrl,
        '--jwt-key-file',
        preexistingKey
      ]);
      const preexistingAuthPath = path.join(primaryHome, '.sfdx', `${config.username}.json`);
      const preexistingAuth = await readFile(preexistingAuthPath);

      scratchAttempted = true;
      if (runner === 'javascript') {
        ({ cleanup } = await pretestSetup('integration'));
      } else {
        const scratch = await ensureScratchOrg();
        expect(scratch.created).toBe(true);
        cleanup = () => scratch.cleanup();
      }

      const ownedHomes = (await readdir(root)).filter(name => name.startsWith('alv-devhub-jwt-'));
      expect(ownedHomes.length).toBe(1);
      jwtHome = path.join(root, ownedHomes[0]!);
      const devHubEnv = salesforceChildEnv(
        process.env,
        process.platform === 'win32' ? { USERPROFILE: jwtHome } : { HOME: jwtHome }
      );
      const devHubQuery = await runSfJson(
        ['data', 'query', '--target-org', config.username, '--query', 'SELECT Id FROM Organization'],
        { env: devHubEnv }
      );
      expect(devHubQuery.result.records[0].Id === expectedDevHubId).toBe(true);
      const devHubState = JSON.parse(await readFile(path.join(jwtHome, '.sfdx', `${config.username}.json`), 'utf8'));
      expect(
        Boolean(devHubState.privateKey) && !devHubState.refreshToken && devHubState.clientId !== 'PlatformCLI'
      ).toBe(true);
      jwtKeyFile = devHubState.privateKey;
      expect(path.dirname(jwtKeyFile!) === jwtHome).toBe(true);
      // Use the installed CLI's AuthInfo writer to encrypt a stale cached token
      // in this owned home. --import runs before CLI startup on its own runtime,
      // including the existing macOS Node 20 wrapper. Never touch caller state.
      const staleTokenFixture = path.join(root, 'stale-token.mjs');
      await writeFile(
        staleTokenFixture,
        `
        import { createRequire } from 'node:module';
        import { realpathSync } from 'node:fs';
        const require = createRequire(realpathSync(process.argv[1]));
        const { AuthInfo } = require('@salesforce/core');
        const auth = await AuthInfo.create({ username: process.env.ALV_JWT_SMOKE_USERNAME });
        await auth.save({ accessToken: 'alv-intentionally-stale-access-token' });
      `
      );
      await runSfJson(['version'], {
        env: {
          ...devHubEnv,
          ALV_JWT_SMOKE_USERNAME: config.username,
          NODE_OPTIONS: `${devHubEnv.NODE_OPTIONS || ''} --import=${pathToFileURL(staleTokenFixture).href}`.trim()
        }
      });
      // A fresh CLI process must recover from the invalid on-disk token using
      // the stored JWT key path before it can complete this real API request.
      expect(existsSync(jwtKeyFile!)).toBe(true);
      const renewed = await runSfJson(
        ['data', 'query', '--target-org', config.username, '--query', 'SELECT Id FROM Organization'],
        { env: devHubEnv }
      );
      expect(renewed.result.records[0].Id === expectedDevHubId).toBe(true);

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
      expect(existsSync(jwtHome)).toBe(false);
      const kept = await runSfJson([
        'data',
        'query',
        '--target-org',
        scratchAlias,
        '--query',
        'SELECT Id FROM Organization'
      ]);
      expect(kept.result.records[0].Id === scratchId).toBe(true);
      // Reattach to the kept scratch with a fresh isolated Dev Hub workflow.
      // Deletion requires that Dev Hub; the caller's auth must remain untouched.
      const deletionSession = await authenticateDevHub(config, runSfJson);
      try {
        await deletionSession.deleteScratch(scratchAlias);
        scratchAttempted = false;
      } finally {
        await deletionSession.cleanup();
      }
      expect((await readFile(preexistingAuthPath)).equals(preexistingAuth)).toBe(true);
      console.info(
        JSON.stringify({
          runner,
          cliVersion: version.cliVersion,
          emptyStateJwt: true,
          devHubJwtWithoutRefreshToken: true,
          renewedJwt: true,
          preexistingSameUsernameIntact: true,
          scratchApi: true,
          independentImportQuery: true,
          workflowCleanup: true,
          isolatedDevHubDeletion: true,
          keptScratchUsableAfterCleanup: true
        })
      );
    } finally {
      try {
        await cleanup?.();
      } finally {
        let remoteCleanupFailed = false;
        try {
          if (scratchAttempted)
            await runSfJson(['org', 'delete', 'scratch', '--target-org', scratchAlias, '--no-prompt']);
        } catch {
          remoteCleanupFailed = true;
        } finally {
          for (const name of Object.keys(process.env)) {
            if (!(name in originalEnv)) delete process.env[name];
          }
          Object.assign(process.env, originalEnv);
        }
        if (remoteCleanupFailed) {
          throw new Error(
            `JWT smoke scratch cleanup failed. Credential state is retained for recovery at: ${root}. Recover or delete the test scratch using that CLI state, then remove the directory.`
          );
        }
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
