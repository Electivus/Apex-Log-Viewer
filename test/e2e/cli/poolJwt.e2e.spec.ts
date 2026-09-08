import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureScratchOrg } from '../utils/scratchOrg';
import { runSfJson } from '../utils/sfCli';
import { getOrgAuth } from '../utils/tooling';
import { authenticateDevHub, resolveDevHubConfig } from '../../../scripts/devhub-auth.js';

const { execFileAsync } = require('../../../scripts/scratch-pool-admin.js');
const repoRoot = path.resolve(__dirname, '../../..');
const homeField = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
const consumerMode = process.env.ALV_POOL_JWT_SMOKE_CONSUMER === '1';

async function admin(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<any> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(repoRoot, 'scripts/scratch-pool-admin.js'), command, ...args, '--json'],
    { cwd: repoRoot, env, timeoutMs: 22 * 60_000 }
  );
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

async function query(target: string, soql: string, env: NodeJS.ProcessEnv): Promise<any[]> {
  const response = await runSfJson(['data', 'query', '--target-org', target, '--query', soql], { env });
  expect(response.status).toBe(0);
  return response.result.records;
}

test('isolated JWT pool administration and independent consumer lifecycle', async () => {
  test.skip(process.env.ALV_POOL_JWT_SMOKE !== '1' || consumerMode, 'Requires authorized isolated pool validation.');
  test.setTimeout(40 * 60_000);
  const originalEnv = { ...process.env };
  const config = resolveDevHubConfig();
  if (config?.mode !== 'jwt' || !config.privateKey) throw new Error('Pool smoke requires inline Dev Hub JWT inputs.');
  const expectedOrg = String(process.env.ALV_JWT_SMOKE_DEVHUB_ORG_ID || '');
  if (!/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(expectedOrg)) {
    throw new Error('Set ALV_JWT_SMOKE_DEVHUB_ORG_ID to the verified authorized Dev Hub.');
  }
  const temporaryRoot = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'alv-pool-jwt-smoke-'));
  const adminHome = path.join(root, 'admin');
  const consumerHome = path.join(root, 'consumer');
  const poolKey = `alv-jwt-pool-${randomUUID()}`;
  const aliasPrefix = `ALV_JWT_POOL_${randomUUID().slice(0, 8)}`;
  const common: NodeJS.ProcessEnv = {
    ...originalEnv,
    CI: 'true',
    SF_DISABLE_TELEMETRY: 'true',
    SF_AUTOUPDATE_DISABLE: 'true',
    SF_SCRATCH_STRATEGY: 'pool',
    SF_SCRATCH_POOL_NAME: poolKey,
    SF_SCRATCH_POOL_LEASE_TTL_SECONDS: '180',
    SF_SCRATCH_POOL_HEARTBEAT_SECONDS: '15',
    SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS: '30',
    ALV_E2E_TIMING: '0',
    TEMP: root,
    TMP: root,
    TMPDIR: root
  };
  for (const name of [
    'SF_DEVHUB_ALIAS',
    'SF_DEVHUB_AUTH_URL',
    'SF_TEMP_SHOW_SECRETS',
    'SF_E2E_ACCESS_TOKEN',
    'SF_E2E_INSTANCE_URL',
    'SF_E2E_TARGET_ORG_ALIAS'
  ])
    delete common[name];
  const adminEnv = { ...common, [homeField]: adminHome };
  let poolMayExist = false;
  let completed = false;
  let cleanupComplete = false;
  const evidence: Record<string, unknown> = { poolKey, temporaryRoot: root, retainedResources: [] };
  try {
    await mkdir(adminHome);
    await mkdir(consumerHome);
    for (const name of Object.keys(process.env)) if (!(name in adminEnv)) delete process.env[name];
    Object.assign(process.env, adminEnv);
    const version = await runSfJson(['version']);
    expect(version.cliVersion).toBe('@salesforce/cli/2.150.6');
    evidence.cliVersion = version.cliVersion;
    evidence.nodeVersion = process.version;
    const empty = await runSfJson(['org', 'list']);
    expect(Object.values(empty.result).filter(Array.isArray).flat().length).toBe(0);
    const inventory = await authenticateDevHub(config, runSfJson);
    try {
      const users = await query(
        inventory.targetOrg,
        `SELECT Id, Username, IsActive FROM User WHERE Username = '${config.username.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
        inventory.env
      );
      const state = JSON.parse(
        await readFile(path.join(inventory.env[homeField]!, '.sfdx', `${config.username}.json`), 'utf8')
      );
      expect(String(state.orgId).slice(0, 15) === expectedOrg.slice(0, 15)).toBe(true);
      expect(state.username === config.username).toBe(true);
      expect(users).toEqual([expect.objectContaining({ Username: config.username, IsActive: true })]);
      expect(Boolean(state.privateKey) && !state.refreshToken && state.clientId !== 'PlatformCLI').toBe(true);
      expect(
        (
          await query(
            inventory.targetOrg,
            `SELECT Id FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${poolKey}'`,
            inventory.env
          )
        ).length
      ).toBe(0);
      evidence.unrelatedActiveScratchesBefore = (
        await query(inventory.targetOrg, 'SELECT Id FROM ActiveScratchOrg', inventory.env)
      ).length;
      evidence.emptyStateJwt = true;
      evidence.devHubJwtWithoutRefreshToken = true;
    } finally {
      await inventory.cleanup();
    }

    poolMayExist = true;
    await admin(
      'bootstrap',
      [
        '--pool-key',
        poolKey,
        '--target-size',
        '2',
        '--scratch-duration-days',
        '1',
        '--lease-ttl-seconds',
        '180',
        '--definition-hash',
        'alv-jwt-pool-smoke-v1',
        '--seed-version',
        'alv-jwt-pool-smoke-v1',
        '--slot-alias-prefix',
        aliasPrefix
      ],
      adminEnv
    );
    // Two logical slots let the existing shrink command delete the only scratch
    // at closeout. Slot 01 remains disabled while slot 02 is used by the runner.
    await admin(
      'disable-slot',
      ['--pool-key', poolKey, '--slot-key', 'slot-01', '--reason', 'Controlled validation'],
      adminEnv
    );
    await admin(
      'reset-slot',
      ['--pool-key', poolKey, '--slot-key', 'slot-02', '--reason', 'Controlled empty-slot validation'],
      adminEnv
    );
    const prewarm = await admin('prewarm', ['--pool-key', poolKey, '--limit', '1'], adminEnv);
    expect(prewarm.prewarmedSlotKeys).toEqual(['slot-02']);
    const reconciled = await admin('reconcile', ['--pool-key', poolKey], adminEnv);
    expect(reconciled.healthySlots).toBe(1);
    const listed = await admin('list', ['--pool-key', poolKey], adminEnv);
    expect(listed.slots.length).toBe(2);
    const prewarmed = listed.slots.find((slot: any) => slot.SlotKey__c === 'slot-02');
    evidence.scratchOrgId = prewarmed.ScratchOrgId__c;
    evidence.scratchOrgInfoId = prewarmed.ScratchOrgInfoId__c;
    expect(prewarmed.HealthState__c).toBe('healthy');
    expect(!JSON.stringify(listed).includes('force://') && !JSON.stringify(listed).includes('LeaseToken__c')).toBe(
      true
    );
    const scratchOrgs = await runSfJson(['org', 'list']);
    expect(
      Object.values(scratchOrgs.result)
        .filter(Array.isArray)
        .flat()
        .some((org: any) => org.username === prewarmed.ScratchUsername__c)
    ).toBe(true);
    // Dev Hub authorization from each admin command is already gone.
    expect((await readdir(root)).some(name => name.startsWith('alv-devhub-jwt-'))).toBe(false);
    evidence.prewarmAndReconcile = true;

    const consumerEnv = {
      ...common,
      [homeField]: consumerHome,
      ALV_POOL_JWT_SMOKE_CONSUMER: '1',
      ALV_POOL_JWT_SMOKE_ROOT: root,
      ALV_POOL_JWT_SMOKE_SCRATCH_ID: prewarmed.ScratchOrgId__c
    };
    const child = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/run-playwright-cli-e2e.js'),
        'test/e2e/cli/poolJwt.e2e.spec.ts',
        '--grep',
        'independent pool runner',
        '--workers=1',
        '--retries=0',
        '--reporter=list',
        '--output=apexlogs/pool-jwt-consumer-results'
      ],
      { cwd: repoRoot, env: consumerEnv, timeoutMs: 10 * 60_000 }
    );
    await writeFile(path.join(root, 'consumer-output.md'), child.stdout, 'utf8');
    evidence.consumer = JSON.parse(await readFile(path.join(root, 'consumer-result.json'), 'utf8'));
    const failedRun = await admin('list', ['--pool-key', poolKey], adminEnv);
    const recoveredSlot = failedRun.slots.find((slot: any) => slot.SlotKey__c === 'slot-02');
    expect(recoveredSlot.LeaseState__c).toBe('available');
    expect(recoveredSlot.HealthState__c).toBe('broken');
    expect(recoveredSlot.LastRunResult__c).toBe('controlled-validation-failure');
    const recovered = await admin('reconcile', ['--pool-key', poolKey], adminEnv);
    expect(recovered.healthySlots).toBe(1);
    evidence.failedConsumerRecovered = true;
    completed = true;
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in adminEnv)) delete process.env[name];
    Object.assign(process.env, adminEnv);
    try {
      if (poolMayExist) {
        const inspection = await authenticateDevHub(config, runSfJson);
        let pools: any[];
        try {
          pools = await query(
            inspection.targetOrg,
            `SELECT Id FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${poolKey}'`,
            inspection.env
          );
        } finally {
          await inspection.cleanup();
        }
        if (pools.length) {
          expect(pools.length).toBe(1);
          const beforeCleanup = await admin('list', ['--pool-key', poolKey], adminEnv);
          if (beforeCleanup.slots.some((slot: any) => slot.SlotKey__c === 'slot-02')) {
            await admin(
              'disable-slot',
              ['--pool-key', poolKey, '--slot-key', 'slot-02', '--reason', 'Controlled validation cleanup'],
              adminEnv
            );
          }
          await admin(
            'bootstrap',
            ['--pool-key', poolKey, '--target-size', '1', '--disabled', '--slot-alias-prefix', aliasPrefix],
            adminEnv
          );
          const deletion = await authenticateDevHub(config, runSfJson);
          try {
            expect(
              (
                await query(
                  deletion.targetOrg,
                  `SELECT Id FROM ScratchOrgInfo WHERE alvPoolKey__c = '${poolKey}'`,
                  deletion.env
                )
              ).length
            ).toBe(0);
            const slots = await query(
              deletion.targetOrg,
              `SELECT Id FROM ALV_ScratchOrgPoolSlot__c WHERE Pool__c = '${pools[0].Id}'`,
              deletion.env
            );
            for (const slot of slots) {
              const deleted = await runSfJson(
                [
                  'data',
                  'delete',
                  'record',
                  '--sobject',
                  'ALV_ScratchOrgPoolSlot__c',
                  '--record-id',
                  slot.Id,
                  '--target-org',
                  deletion.targetOrg
                ],
                { env: deletion.env }
              );
              expect(deleted.status).toBe(0);
            }
            const deleted = await runSfJson(
              [
                'data',
                'delete',
                'record',
                '--sobject',
                'ALV_ScratchOrgPool__c',
                '--record-id',
                pools[0].Id,
                '--target-org',
                deletion.targetOrg
              ],
              { env: deletion.env }
            );
            expect(deleted.status).toBe(0);
            expect(
              (
                await query(
                  deletion.targetOrg,
                  `SELECT Id FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${poolKey}'`,
                  deletion.env
                )
              ).length
            ).toBe(0);
            evidence.unrelatedActiveScratchesAfter = (
              await query(deletion.targetOrg, 'SELECT Id FROM ActiveScratchOrg', deletion.env)
            ).length;
            evidence.ownedScratchAndPoolDeleted = true;
          } finally {
            await deletion.cleanup();
          }
        }
      }
      cleanupComplete = true;
    } catch (error) {
      // Keep cleanup failures observable without replacing them with a generic
      // retained-resource message in the outer finally block.
      evidence.cleanupError = error instanceof Error ? error.message : 'Unknown cleanup failure';
      throw error;
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
      Object.assign(process.env, originalEnv);
      evidence.completed = completed;
      evidence.remoteCleanupComplete = cleanupComplete;
      let localCleanupComplete = false;
      try {
        if (cleanupComplete) {
          if (
            path.dirname(path.resolve(root)) !== temporaryRoot ||
            !path.basename(root).startsWith('alv-pool-jwt-smoke-')
          ) {
            throw new Error('Refusing cleanup outside the owned pool smoke directory.');
          }
          await rm(root, { recursive: true, force: true });
          localCleanupComplete = true;
        }
      } catch (error) {
        evidence.cleanupError = error instanceof Error ? error.message : 'Unknown local cleanup failure';
        throw error;
      } finally {
        evidence.cleanupComplete = cleanupComplete && localCleanupComplete;
        if (!evidence.cleanupComplete) {
          evidence.retainedResources = [{ ...(cleanupComplete ? {} : { poolKey }), credentialDirectory: root }];
        }
        const evidenceDirectory = path.join(repoRoot, 'apexlogs');
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(
          path.join(evidenceDirectory, 'pool-jwt-smoke-evidence.json'),
          JSON.stringify(evidence, null, 2)
        );
      }
    }
  }
});

test('independent pool runner imports, queries, renews and releases its lease', async () => {
  test.skip(process.env.ALV_POOL_JWT_SMOKE !== '1' || !consumerMode, 'Run only as the isolated smoke consumer.');
  test.setTimeout(8 * 60_000);
  const root = String(process.env.ALV_POOL_JWT_SMOKE_ROOT || '');
  if (!path.isAbsolute(root) || !path.basename(root).startsWith('alv-pool-jwt-smoke-')) {
    throw new Error('Missing owned pool smoke directory.');
  }
  const empty = await runSfJson(['org', 'list']);
  expect(Object.values(empty.result).filter(Array.isArray).flat().length).toBe(0);
  const originalFetch = globalThis.fetch;
  const statuses: number[] = [];
  let expired = false;
  let heartbeatSucceeded!: () => void;
  const heartbeat = new Promise<void>(resolve => {
    heartbeatSucceeded = resolve;
  });
  let timeout: NodeJS.Timeout | undefined;
  globalThis.fetch = async (input, options) => {
    const isHeartbeat = String(input).endsWith('/scratch-pool/v1/heartbeat');
    if (isHeartbeat && !expired) {
      expired = true;
      const headers = new Headers(options?.headers);
      headers.set('Authorization', 'Bearer alv-controlled-invalid-token');
      const rejected = await originalFetch(input, { ...options, headers });
      statuses.push(rejected.status);
      return rejected;
    }
    const response = await originalFetch(input, options);
    if (isHeartbeat) {
      statuses.push(response.status);
      if (response.ok) heartbeatSucceeded();
    }
    return response;
  };
  let scratch: Awaited<ReturnType<typeof ensureScratchOrg>> | undefined;
  let phase = 'acquire-and-import';
  try {
    scratch = await ensureScratchOrg();
    phase = 'query-imported-scratch';
    expect(scratch.created).toBe(false);
    expect(scratch.slotKey).toBe('slot-02');
    const queried = await runSfJson([
      'data',
      'query',
      '--target-org',
      scratch.scratchAlias,
      '--query',
      'SELECT Id FROM Organization'
    ]);
    expect(
      String(queried.result.records[0].Id).slice(0, 15) ===
        String(process.env.ALV_POOL_JWT_SMOKE_SCRATCH_ID).slice(0, 15)
    ).toBe(true);
    const auth = await getOrgAuth(scratch.scratchAlias);
    const state = JSON.parse(
      await readFile(path.join(process.env[homeField]!, '.sfdx', `${auth.username}.json`), 'utf8')
    );
    expect(Boolean(state.refreshToken) && !state.privateKey && state.clientId === 'PlatformCLI').toBe(true);
    // Start the heartbeat observation deadline after the independent CLI login
    // and import, which may take longer than 90 seconds on corporate Windows.
    await Promise.race([
      heartbeat,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('No successful renewed pool heartbeat was observed.')), 90_000);
      })
    ]);
    expect(statuses.includes(401) && statuses.includes(200)).toBe(true);
    scratch.assertLeaseHealthy?.();
    phase = 'successful-release';
    await scratch.cleanup();
    scratch = undefined;
    expect((await readdir(root)).some(name => name.startsWith('alv-devhub-jwt-'))).toBe(false);

    scratch = await ensureScratchOrg();
    phase = 'controlled-failure-release';
    expect(scratch.created).toBe(false);
    await scratch.cleanup({
      success: false,
      needsRecreate: false,
      lastRunResult: 'controlled-validation-failure',
      errorMessage: 'Controlled validation failure; scratch retained.'
    });
    scratch = undefined;
    await writeFile(
      path.join(root, 'consumer-result.json'),
      JSON.stringify(
        {
          emptyCallerState: true,
          reusedPrewarmedScratch: true,
          scratchQuery: true,
          platformCliRefreshTokenImport: true,
          renewedJwtHeartbeat: true,
          finalizedAndReleased: true,
          failureReleasedForRecovery: true
        },
        null,
        2
      )
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    try {
      await scratch?.cleanup({ success: false, needsRecreate: false, lastRunResult: 'validation-interrupted' });
    } finally {
      globalThis.fetch = originalFetch;
      await writeFile(
        path.join(root, 'consumer-progress.json'),
        JSON.stringify({ phase, heartbeatStatuses: statuses })
      );
    }
  }
});
