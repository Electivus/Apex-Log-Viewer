import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { getOrgAuth, assertToolingReady, primeOrgAuthCache, type OrgAuth } from './tooling';
import { runSfJson } from './sfCli';
import { timeE2eStep } from './timing';

export type ScratchOrgStrategy = 'single' | 'pool';

export type ScratchOrgCleanupOptions = {
  success?: boolean;
  needsRecreate?: boolean;
  errorMessage?: string;
  lastRunResult?: string;
};

export type ScratchOrgResult = {
  devHubAlias: string;
  scratchAlias: string;
  created: boolean;
  strategy: ScratchOrgStrategy;
  slotKey?: string;
  leaseToken?: string;
  cleanup: (options?: ScratchOrgCleanupOptions) => Promise<void>;
  assertLeaseHealthy?: () => void;
};

type DevHubConfig = {
  authUrl?: string;
  alias?: string;
};

const DEFAULT_DEV_HUB_ALIAS = 'ConfiguredDevHub';

type OrgDisplaySummary = {
  status?: string;
  expirationDate?: string;
  accessToken?: string;
  instanceUrl?: string;
  username?: string;
  sfdxAuthUrl?: string;
};

type HttpError = Error & {
  status?: number;
  responseBody?: string;
};

type PoolAcquireRequest = {
  poolKey: string;
  leaseOwner: string;
  leaseTtlSeconds: number;
  definitionHash: string;
  seedVersion: string;
  minRemainingMinutes: number;
};

type PoolAcquireResponse = {
  ok?: boolean;
  poolKey?: string;
  slotKey?: string;
  scratchAlias?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  leaseState?: string;
  leaseOwner?: string;
  needsCreate?: boolean;
  scratchUsername?: string;
  scratchLoginUrl?: string;
  scratchAuthUrl?: string;
  scratchOrgId?: string;
  scratchOrgInfoId?: string;
  activeScratchOrgId?: string;
  scratchExpiresAt?: string;
  definitionHash?: string;
  seedVersion?: string;
  provisioningMode?: string;
  snapshotName?: string;
  scratchDurationDays?: number;
};

type PoolHeartbeatRequest = {
  poolKey: string;
  slotKey: string;
  leaseToken: string;
  leaseTtlSeconds: number;
};

type PoolFinalizeRequest = {
  poolKey: string;
  slotKey: string;
  leaseToken: string;
  definitionHash: string;
  seedVersion: string;
  created: boolean;
  lastRunResult?: string;
  scratchAuthUrl?: string;
};

type PoolReleaseRequest = {
  poolKey: string;
  slotKey: string;
  leaseToken: string;
  success: boolean;
  needsRecreate?: boolean;
  lastRunResult?: string;
  errorMessage?: string;
  scratchAuthUrl?: string;
};

type PoolConfigSummary = {
  snapshotName?: string;
  definitionHash?: string;
  seedVersion?: string;
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

function readEnvValue(name: string): string | undefined {
  const value = String(process.env[name] || '').trim();
  return value || undefined;
}

function mapOrgDisplay(result: any): OrgDisplaySummary {
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
    username: typeof org.username === 'string' ? org.username : undefined,
    sfdxAuthUrl: typeof org.sfdxAuthUrl === 'string' ? org.sfdxAuthUrl : undefined
  };
}

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

function shouldKeepScratchOrg(): boolean {
  if (process.env.SF_TEST_KEEP_ORG !== undefined) {
    return envFlag('SF_TEST_KEEP_ORG');
  }
  return !envFlag('CI');
}

function resolveScratchStrategy(): ScratchOrgStrategy {
  const configured = String(process.env.SF_SCRATCH_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (!configured) {
    return readEnvValue('SF_SCRATCH_POOL_NAME') ? 'pool' : 'single';
  }
  if (configured === 'single' || configured === 'pool') {
    return configured;
  }
  throw new Error(`Invalid SF_SCRATCH_STRATEGY value '${configured}'. Expected 'single' or 'pool'.`);
}

function resolveRequiredDevHubConfig(): DevHubConfig {
  const authUrl = readEnvValue('SF_DEVHUB_AUTH_URL');
  const alias = readEnvValue('SF_DEVHUB_ALIAS');

  if (!authUrl && !alias) {
    throw new Error('Missing required Dev Hub configuration. Set SF_DEVHUB_AUTH_URL or SF_DEVHUB_ALIAS.');
  }
  return { authUrl, alias };
}

async function getOrgDisplayOrThrow(alias: string, options?: { verbose?: boolean }): Promise<OrgDisplaySummary> {
  const args = ['org', 'display', '-o', alias];
  if (options?.verbose) {
    args.push('--verbose');
  }
  return mapOrgDisplay(await runSfJson(args));
}

async function getOrgDisplay(alias: string, options?: { verbose?: boolean }): Promise<OrgDisplaySummary | undefined> {
  try {
    return await getOrgDisplayOrThrow(alias, options);
  } catch (error) {
    console.warn(
      `[e2e] sf org display failed for alias '${alias}': ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
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

async function ensureDevHubAuth(config: DevHubConfig): Promise<string> {
  const authUrl = config.authUrl;
  if (!authUrl) {
    const devHubAlias = config.alias;
    if (!devHubAlias) {
      throw new Error('Missing required Dev Hub configuration. Set SF_DEVHUB_AUTH_URL or SF_DEVHUB_ALIAS.');
    }
    try {
      await getOrgDisplayOrThrow(devHubAlias);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Dev Hub alias '${devHubAlias}' is not authenticated or unavailable. ${detail}`.trim());
    }
    return devHubAlias;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'alv-devhub-'));
  const filePath = path.join(dir, 'devhub.sfdxurl');
  await writeFile(filePath, authUrl, 'utf8');
  try {
    const args = ['org', 'login', 'sfdx-url', '--sfdx-url-file', filePath, '--set-default-dev-hub'];
    const resolvedDevHubAlias = config.alias || DEFAULT_DEV_HUB_ALIAS;
    args.push('--alias', resolvedDevHubAlias);
    await runSfJson(args);
    return resolvedDevHubAlias;
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
        await runSfJson(
          [
            'data',
            'query',
            '--query',
            'SELECT Id FROM DebugLevel LIMIT 1',
            '--use-tooling-api',
            '--target-org',
            targetOrg
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

type ScratchProjectContext = {
  cwd: string;
  defFile: string;
  cleanup: (shouldDeleteScratch: boolean, scratchAlias: string) => Promise<void>;
};

async function createScratchProjectContext(definition: Record<string, unknown>): Promise<ScratchProjectContext> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'alv-scratch-'));
  const defFile = path.join(tmp, 'project-scratch-def.json');
  const projectFile = path.join(tmp, 'sfdx-project.json');

  await writeFile(defFile, JSON.stringify(definition, null, 2), 'utf8');
  await mkdir(path.join(tmp, 'force-app'), { recursive: true });
  await writeFile(
    projectFile,
    JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        name: 'apex-log-viewer-e2e',
        namespace: '',
        sfdcLoginUrl: 'https://login.salesforce.com',
        sourceApiVersion: '65.0'
      },
      null,
      2
    ),
    'utf8'
  );

  return {
    cwd: tmp,
    defFile,
    cleanup: async (shouldDeleteScratch: boolean, scratchAlias: string) => {
      try {
        if (shouldDeleteScratch) {
          try {
            await runSfJson(['org', 'delete', 'scratch', '-o', scratchAlias, '--no-prompt'], { cwd: tmp });
          } catch {
            // Best-effort cleanup.
          }
        }
      } finally {
        try {
          await rm(tmp, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  };
}

function stableJsonForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => stableJsonForHash(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const normalized: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    normalized[key] = stableJsonForHash(entryValue);
  }
  return normalized;
}

function createDefinitionHash(definition: Record<string, unknown>): string {
  const normalized = stableJsonForHash(definition);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildBaseScratchDefinition(options?: { snapshotName?: string }): Record<string, unknown> {
  if (options?.snapshotName) {
    return {
      orgName: 'apex-log-viewer-e2e',
      snapshot: options.snapshotName
    };
  }
  return {
    orgName: 'apex-log-viewer-e2e',
    edition: 'Developer',
    hasSampleData: false
  };
}

function buildPoolScratchDefinition(options: {
  poolKey: string;
  slotKey: string;
  definitionHash: string;
  seedVersion: string;
  snapshotName?: string;
}): Record<string, unknown> {
  return {
    ...buildBaseScratchDefinition({ snapshotName: options.snapshotName }),
    alvPoolKey__c: options.poolKey,
    alvSlotKey__c: options.slotKey,
    alvDefinitionHash__c: options.definitionHash,
    alvSeedVersion__c: options.seedVersion
  };
}

function resolvePoolSeedVersion(): string {
  return String(process.env.SF_SCRATCH_POOL_SEED_VERSION || '').trim();
}

function resolvePoolKey(): string {
  const poolKey = readEnvValue('SF_SCRATCH_POOL_NAME');
  if (!poolKey) {
    throw new Error('Missing required scratch-org pool configuration. Set SF_SCRATCH_POOL_NAME.');
  }
  return poolKey;
}

function resolvePoolLeaseOwner(): string {
  const configured = readEnvValue('SF_SCRATCH_POOL_OWNER');
  if (configured) {
    return configured;
  }
  if (process.env.GITHUB_RUN_ID) {
    return `github:${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  }
  return `local:${hostname()}:${process.pid}`;
}

function resolvePoolLeaseTtlSeconds(): number {
  return Math.max(60, Number(process.env.SF_SCRATCH_POOL_LEASE_TTL_SECONDS || 5400) || 5400);
}

function resolvePoolAcquireTimeoutSeconds(): number {
  return Math.max(30, Number(process.env.SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS || 600) || 600);
}

function resolvePoolHeartbeatSeconds(leaseTtlSeconds: number): number {
  const defaultHeartbeatSeconds = Math.max(30, Math.min(60, Math.floor(leaseTtlSeconds / 2)));
  if (process.env.SF_SCRATCH_POOL_HEARTBEAT_SECONDS !== undefined) {
    const rawValue = String(process.env.SF_SCRATCH_POOL_HEARTBEAT_SECONDS || '').trim();
    if (!rawValue) {
      return defaultHeartbeatSeconds;
    }
    const configured = Number(rawValue);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 0;
    }
    return Math.max(15, Math.floor(configured));
  }
  return defaultHeartbeatSeconds;
}

function resolvePoolMinRemainingMinutes(): number {
  return Math.max(0, Number(process.env.SF_SCRATCH_POOL_MIN_REMAINING_MINUTES || 120) || 120);
}

function resolvePoolSnapshotName(): string | undefined {
  return readEnvValue('SF_SCRATCH_POOL_SNAPSHOT_NAME');
}

function isHttpError(error: unknown, status: number): boolean {
  return Number((error as HttpError | undefined)?.status) === status;
}

async function requestOrgJson(auth: OrgAuth, method: string, resourcePath: string, body?: unknown): Promise<any> {
  const url = `${auth.instanceUrl.replace(/\/+$/, '')}${resourcePath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    const safeDetail = formatHttpErrorDetail(text);
    const error = new Error(
      `HTTP ${response.status} for ${resourcePath}${safeDetail ? ` -> ${safeDetail}` : ''}`
    ) as HttpError;
    error.status = response.status;
    error.responseBody = text;
    throw error;
  }
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function escapeSoqlLiteral(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function queryOrgRecords(auth: OrgAuth, soql: string): Promise<any[]> {
  const response = await requestOrgJson(
    auth,
    'GET',
    `/services/data/v${auth.apiVersion}/query/?q=${encodeURIComponent(soql)}`
  );
  return Array.isArray(response?.records) ? response.records : [];
}

function formatHttpErrorDetail(text: string): string | undefined {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const messages = collectSafeErrorMessages(parsed);
    if (messages.length > 0) {
      return messages.join(' | ');
    }
  } catch {
    // Fall through to a generic redacted marker.
  }

  return 'response body redacted';
}

function collectSafeErrorMessages(value: unknown): string[] {
  const messages = new Set<string>();
  const queue: unknown[] = [value];

  while (queue.length > 0 && messages.size < 3) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    const errorCode = typeof record.errorCode === 'string' ? record.errorCode.trim() : '';
    const error = typeof record.error === 'string' ? record.error.trim() : '';

    if (message) {
      messages.add(errorCode ? `${errorCode}: ${message}` : message);
    } else if (error) {
      messages.add(error);
    }

    if (Array.isArray(record.errors)) {
      queue.push(...record.errors);
    }
  }

  return Array.from(messages);
}

async function acquirePoolLeaseWithRetry(auth: OrgAuth, request: PoolAcquireRequest): Promise<PoolAcquireResponse> {
  const timeoutMs = resolvePoolAcquireTimeoutSeconds() * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return (await requestOrgJson(auth, 'POST', '/services/apexrest/alv/scratch-pool/v1/acquire', request)) as PoolAcquireResponse;
    } catch (error) {
      lastError = error;
      if (!isHttpError(error, 409)) {
        throw error;
      }
      await sleep(5_000);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || '');
  throw new Error(`Timed out waiting for a scratch-org pool lease after ${timeoutMs}ms. ${detail}`.trim());
}

async function heartbeatPoolLease(auth: OrgAuth, request: PoolHeartbeatRequest): Promise<void> {
  await requestOrgJson(auth, 'POST', '/services/apexrest/alv/scratch-pool/v1/heartbeat', request);
}

async function finalizePoolLease(auth: OrgAuth, request: PoolFinalizeRequest): Promise<PoolAcquireResponse> {
  return (await requestOrgJson(auth, 'POST', '/services/apexrest/alv/scratch-pool/v1/finalize', request)) as PoolAcquireResponse;
}

async function releasePoolLease(auth: OrgAuth, request: PoolReleaseRequest): Promise<void> {
  await requestOrgJson(auth, 'POST', '/services/apexrest/alv/scratch-pool/v1/release', request);
}

async function tryReleaseIncompletePoolLease(
  auth: OrgAuth,
  poolKey: string,
  lease: Partial<PoolAcquireResponse>,
  errorMessage: string
): Promise<void> {
  const slotKey = String(lease.slotKey || '').trim();
  const leaseToken = String(lease.leaseToken || '').trim();
  if (!slotKey || !leaseToken) {
    return;
  }

  try {
    await releasePoolLease(auth, {
      poolKey,
      slotKey,
      leaseToken,
      success: false,
      needsRecreate: true,
      lastRunResult: 'failed',
      errorMessage
    });
  } catch (error) {
    console.warn(
      `[e2e] scratch-org pool release failed after an incomplete acquire response for slot '${slotKey}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function deleteExistingPooledScratch(
  auth: OrgAuth,
  lease: Pick<PoolAcquireResponse, 'poolKey' | 'slotKey' | 'activeScratchOrgId' | 'scratchOrgInfoId'>
): Promise<void> {
  const triedIds = new Set<string>();

  const tryDeleteByIds = async (ids: { activeScratchOrgId?: string; scratchOrgInfoId?: string }): Promise<boolean> => {
    if (ids.activeScratchOrgId) {
      triedIds.add(ids.activeScratchOrgId);
      try {
        await requestOrgJson(auth, 'DELETE', `/services/data/v${auth.apiVersion}/sobjects/ActiveScratchOrg/${ids.activeScratchOrgId}`);
        return true;
      } catch (error) {
        if (!isHttpError(error, 404)) {
          throw error;
        }
      }
    }
    if (ids.scratchOrgInfoId) {
      triedIds.add(ids.scratchOrgInfoId);
      try {
        await requestOrgJson(auth, 'DELETE', `/services/data/v${auth.apiVersion}/sobjects/ScratchOrgInfo/${ids.scratchOrgInfoId}`);
        return true;
      } catch (error) {
        if (!isHttpError(error, 404)) {
          throw error;
        }
      }
    }
    return false;
  };

  if (await tryDeleteByIds(lease)) {
    return;
  }

  const poolKey = String(lease.poolKey || '').trim();
  const slotKey = String(lease.slotKey || '').trim();
  if (!poolKey || !slotKey) {
    return;
  }

  const latestInfoRecords = await queryOrgRecords(
    auth,
    [
      'SELECT Id',
      'FROM ScratchOrgInfo',
      `WHERE alvPoolKey__c = '${escapeSoqlLiteral(poolKey)}' AND alvSlotKey__c = '${escapeSoqlLiteral(slotKey)}'`,
      'ORDER BY CreatedDate DESC',
      'LIMIT 1'
    ].join(' ')
  );
  const latestScratchOrgInfoId = String(latestInfoRecords[0]?.Id || '').trim();
  if (!latestScratchOrgInfoId || triedIds.has(latestScratchOrgInfoId)) {
    return;
  }

  const activeScratchRecords = await queryOrgRecords(
    auth,
    [
      'SELECT Id',
      'FROM ActiveScratchOrg',
      `WHERE ScratchOrgInfoId = '${escapeSoqlLiteral(latestScratchOrgInfoId)}'`,
      'ORDER BY CreatedDate DESC',
      'LIMIT 1'
    ].join(' ')
  );
  const latestActiveScratchOrgId = String(activeScratchRecords[0]?.Id || '').trim();
  await tryDeleteByIds({
    activeScratchOrgId: latestActiveScratchOrgId || undefined,
    scratchOrgInfoId: latestScratchOrgInfoId
  });
}

async function getPoolConfig(auth: OrgAuth, poolKey: string): Promise<PoolConfigSummary | undefined> {
  const records = await queryOrgRecords(
    auth,
    [
      'SELECT SnapshotName__c, DefinitionHash__c, SeedVersion__c',
      'FROM ALV_ScratchOrgPool__c',
      `WHERE PoolKey__c = '${escapeSoqlLiteral(poolKey)}'`,
      'LIMIT 1'
    ].join(' ')
  );
  const record = records[0];
  if (!record) {
    return undefined;
  }
  const snapshotName = String(record.SnapshotName__c || '').trim();
  const definitionHash = String(record.DefinitionHash__c || '').trim();
  const seedVersion = String(record.SeedVersion__c || '').trim();
  return {
    snapshotName: snapshotName || undefined,
    definitionHash: definitionHash || undefined,
    seedVersion: seedVersion || undefined
  };
}

async function resolveEffectivePoolBaseline(
  auth: OrgAuth,
  poolKey: string
): Promise<{ definitionHash: string; seedVersion: string; snapshotName?: string }> {
  const poolConfig = await getPoolConfig(auth, poolKey);
  const snapshotName = resolvePoolSnapshotName() || poolConfig?.snapshotName;
  const seedVersion = resolvePoolSeedVersion() || poolConfig?.seedVersion || 'alv-e2e-baseline-v1';
  return {
    definitionHash: poolConfig?.definitionHash || createDefinitionHash(buildBaseScratchDefinition({ snapshotName })),
    seedVersion,
    snapshotName
  };
}

async function loginScratchOrgWithSfdxUrl(scratchAlias: string, scratchAuthUrl: string): Promise<void> {
  if (!scratchAuthUrl) {
    throw new Error('Pooled scratch-org login requires a scratchAuthUrl.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'alv-scratch-auth-'));
  const filePath = path.join(dir, 'scratch.sfdxurl');
  await writeFile(filePath, scratchAuthUrl, 'utf8');
  try {
    await runSfJson(['org', 'login', 'sfdx-url', '--sfdx-url-file', filePath, '--alias', scratchAlias]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function getScratchAuthUrlOrThrow(scratchAlias: string): Promise<string> {
  const display = await getOrgDisplayOrThrow(scratchAlias, { verbose: true });
  const scratchAuthUrl = String(display.sfdxAuthUrl || '').trim();
  if (!scratchAuthUrl) {
    throw new Error(`Scratch org '${scratchAlias}' did not return an sfdxAuthUrl.`);
  }
  return scratchAuthUrl;
}

async function tryGetScratchAuthUrl(scratchAlias: string): Promise<string | undefined> {
  try {
    return await getScratchAuthUrlOrThrow(scratchAlias);
  } catch (error) {
    console.warn(
      `[e2e] scratch org '${scratchAlias}' did not expose an sfdxAuthUrl: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

function startPoolLeaseHeartbeat(
  auth: OrgAuth,
  request: PoolHeartbeatRequest,
  intervalSeconds: number
): { stop: () => void; getFailure: () => Error | undefined; assertHealthy: () => void } {
  if (intervalSeconds <= 0) {
    return {
      stop: () => undefined,
      getFailure: () => undefined,
      assertHealthy: () => undefined
    };
  }

  let stopped = false;
  let failureStartedAt: number | undefined;
  let leaseFailure: Error | undefined;
  const leaseTtlMs = Math.max(1, request.leaseTtlSeconds) * 1000;
  const timer = setInterval(() => {
    if (stopped || leaseFailure) {
      return;
    }
    const tickStartedAt = Date.now();
    void heartbeatPoolLease(auth, request)
      .then(() => {
        failureStartedAt = undefined;
      })
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        const failureNow = Date.now();
        failureStartedAt ??= tickStartedAt;
        console.warn(`[e2e] scratch-org pool heartbeat failed for slot '${request.slotKey}': ${detail}`);
        if (failureNow - failureStartedAt >= leaseTtlMs) {
          leaseFailure = new Error(
            `Scratch-org pool lease for slot '${request.slotKey}' was lost after heartbeat failures exceeded the ${request.leaseTtlSeconds}s TTL. ${detail}`.trim()
          );
        }
      });
  }, intervalSeconds * 1000);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    getFailure: () => leaseFailure,
    assertHealthy: () => {
      if (leaseFailure) {
        throw leaseFailure;
      }
    }
  };
}

async function ensureSingleScratchOrg(): Promise<ScratchOrgResult> {
  const devHubConfig = resolveRequiredDevHubConfig();
  const devHubAlias = await ensureDevHubAuth(devHubConfig);
  const scratchAlias = String(process.env.SF_SCRATCH_ALIAS || 'ALV_E2E_Scratch').trim();
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1) || 1;
  const keep = shouldKeepScratchOrg();

  const existingScratch = await getOrgDisplay(scratchAlias);
  if (isReusableScratchOrg(existingScratch)) {
    const auth = toOrgAuth(existingScratch);
    if (auth) {
      primeOrgAuthCache(scratchAlias, auth);
    }
    await waitForScratchOrgReady(scratchAlias, auth);
    console.info(`[e2e] scratch org reused for alias '${scratchAlias}'.`);
    return {
      devHubAlias,
      scratchAlias,
      created: false,
      strategy: 'single',
      cleanup: async () => {
        if (keep) {
          return;
        }
        try {
          await runSfJson(['org', 'delete', 'scratch', '-o', scratchAlias, '--no-prompt']);
        } catch {
          // Best-effort cleanup.
        }
      }
    };
  }

  if (existingScratch) {
    console.warn(
      `[e2e] scratch alias '${scratchAlias}' points to a stale org (status='${existingScratch.status || 'unknown'}', expiration='${existingScratch.expirationDate || 'unknown'}'); recreating.`
    );
    await clearStaleScratchOrg(scratchAlias);
  }

  const context = await createScratchProjectContext(buildBaseScratchDefinition());
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
        context.defFile,
        '--duration-days',
        String(durationDays),
        '--wait',
        '15'
      ],
      { cwd: context.cwd }
    );
  } catch (error) {
    await context.cleanup(!keep, scratchAlias);
    const msg = error instanceof Error ? error.message : String(error);
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

  console.info(`[e2e] scratch org created for alias '${scratchAlias}'.`);
  return {
    devHubAlias,
    scratchAlias,
    created: true,
    strategy: 'single',
    cleanup: async () => {
      await context.cleanup(!keep, scratchAlias);
    }
  };
}

async function ensurePooledScratchOrg(): Promise<ScratchOrgResult> {
  const devHubConfig = resolveRequiredDevHubConfig();
  const devHubAlias = await ensureDevHubAuth(devHubConfig);
  const devHubAuth = await getOrgAuth(devHubAlias, { forceRefresh: true });
  const poolKey = resolvePoolKey();
  const requestedBaseline = await resolveEffectivePoolBaseline(devHubAuth, poolKey);
  const leaseTtlSeconds = resolvePoolLeaseTtlSeconds();
  const acquireRequest: PoolAcquireRequest = {
    poolKey,
    leaseOwner: resolvePoolLeaseOwner(),
    leaseTtlSeconds,
    definitionHash: requestedBaseline.definitionHash,
    seedVersion: requestedBaseline.seedVersion,
    minRemainingMinutes: resolvePoolMinRemainingMinutes()
  };

  const lease = await acquirePoolLeaseWithRetry(devHubAuth, acquireRequest);
  const slotKey = String(lease.slotKey || '').trim();
  const scratchAlias = String(lease.scratchAlias || '').trim();
  const leaseToken = String(lease.leaseToken || '').trim();
  if (!slotKey || !scratchAlias || !leaseToken) {
    const missingFields = [
      !slotKey ? 'slotKey' : '',
      !scratchAlias ? 'scratchAlias' : '',
      !leaseToken ? 'leaseToken' : ''
    ].filter(Boolean);
    const errorMessage = `Scratch-org pool acquire response was missing ${missingFields.join(', ')}.`;
    await tryReleaseIncompletePoolLease(devHubAuth, poolKey, lease, errorMessage);
    throw new Error(errorMessage);
  }

  const heartbeatIntervalSeconds = resolvePoolHeartbeatSeconds(leaseTtlSeconds);
  const heartbeat = startPoolLeaseHeartbeat(
    devHubAuth,
    {
      poolKey,
      slotKey,
      leaseToken,
      leaseTtlSeconds
    },
    heartbeatIntervalSeconds
  );

  const cleanup = async (options?: ScratchOrgCleanupOptions) => {
    heartbeat.stop();
    const heartbeatFailure = heartbeat.getFailure();
    let resolvedScratchAuthUrl: string | undefined;
    let needsRecreate = options?.needsRecreate ?? Boolean(heartbeatFailure);
    const success = options?.success ?? !heartbeatFailure;
    const errorMessage =
      options?.errorMessage ||
      (heartbeatFailure ? heartbeatFailure.message : undefined);
    const lastRunResult =
      options?.lastRunResult ||
      (success ? 'completed' : heartbeatFailure ? 'lease-lost' : 'failed');
    if (!needsRecreate) {
      resolvedScratchAuthUrl = await tryGetScratchAuthUrl(scratchAlias);
      if (!resolvedScratchAuthUrl) {
        needsRecreate = true;
      }
    }
    try {
      await releasePoolLease(devHubAuth, {
        poolKey,
        slotKey,
        leaseToken,
        success,
        needsRecreate,
        errorMessage,
        lastRunResult,
        scratchAuthUrl: resolvedScratchAuthUrl
      });
    } catch (error) {
      console.warn(
        `[e2e] scratch-org pool release failed for slot '${slotKey}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  try {
    let created = false;
    let readyAuth: OrgAuth | undefined;
    let scratchAuthUrl: string | undefined;
    const shouldCreate = Boolean(lease.needsCreate);
    const effectiveSnapshotName = lease.snapshotName || requestedBaseline.snapshotName;
    const effectiveDefinitionHash = requestedBaseline.definitionHash;
    const effectiveSeedVersion = requestedBaseline.seedVersion;

    if (!shouldCreate && lease.scratchAuthUrl) {
      try {
        await loginScratchOrgWithSfdxUrl(scratchAlias, lease.scratchAuthUrl);
        const display = await getOrgDisplayOrThrow(scratchAlias);
        readyAuth = toOrgAuth(display);
        if (readyAuth) {
          primeOrgAuthCache(scratchAlias, readyAuth);
        }
        await waitForScratchOrgReady(scratchAlias, readyAuth);
        scratchAuthUrl = (await tryGetScratchAuthUrl(scratchAlias)) || lease.scratchAuthUrl;
        await finalizePoolLease(devHubAuth, {
          poolKey,
          slotKey,
          leaseToken,
          definitionHash: effectiveDefinitionHash,
          seedVersion: effectiveSeedVersion,
          created: false,
          lastRunResult: 'reused',
          scratchAuthUrl
        });
        console.info(`[e2e] scratch-org pool slot '${slotKey}' reused scratch '${scratchAlias}'.`);
      } catch (error) {
        if (isHttpError(error, 409)) {
          throw error;
        }
        readyAuth = undefined;
        scratchAuthUrl = undefined;
        console.warn(
          `[e2e] scratch-org pool slot '${slotKey}' could not reuse scratch '${scratchAlias}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (!readyAuth) {
      created = true;
      try {
        await deleteExistingPooledScratch(devHubAuth, lease);
      } catch (error) {
        console.warn(
          `[e2e] scratch-org pool slot '${slotKey}' could not delete the previous scratch before recreation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      await clearStaleScratchOrg(scratchAlias);

      const durationDays = Math.max(1, Number(lease.scratchDurationDays || process.env.SF_SCRATCH_DURATION || 30) || 30);
      const context = await createScratchProjectContext(
        buildPoolScratchDefinition({
          poolKey,
          slotKey,
          definitionHash: effectiveDefinitionHash,
          seedVersion: effectiveSeedVersion,
          snapshotName: effectiveSnapshotName
        })
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
            context.defFile,
            '--duration-days',
            String(durationDays),
            '--wait',
            '15'
          ],
          { cwd: context.cwd }
        );
      } finally {
        await context.cleanup(false, scratchAlias);
      }

      const display = await getOrgDisplayOrThrow(scratchAlias);
      readyAuth = toOrgAuth(display);
      if (readyAuth) {
        primeOrgAuthCache(scratchAlias, readyAuth);
      }
      await waitForScratchOrgReady(scratchAlias, readyAuth);
      scratchAuthUrl = await getScratchAuthUrlOrThrow(scratchAlias);
      await finalizePoolLease(devHubAuth, {
        poolKey,
        slotKey,
        leaseToken,
        definitionHash: effectiveDefinitionHash,
        seedVersion: effectiveSeedVersion,
        created: true,
        lastRunResult: 'created',
        scratchAuthUrl
      });
      console.info(`[e2e] scratch-org pool slot '${slotKey}' created scratch '${scratchAlias}'.`);
    }

    return {
      devHubAlias,
      scratchAlias,
      created,
      strategy: 'pool',
      slotKey,
      leaseToken,
      cleanup,
      assertLeaseHealthy: () => {
        heartbeat.assertHealthy();
      }
    };
  } catch (error) {
    await cleanup({
      success: false,
      needsRecreate: true,
      lastRunResult: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function ensureScratchOrg(): Promise<ScratchOrgResult> {
  return await timeE2eStep('scratch.ensure', async () => {
    return resolveScratchStrategy() === 'pool' ? await ensurePooledScratchOrg() : await ensureSingleScratchOrg();
  });
}
