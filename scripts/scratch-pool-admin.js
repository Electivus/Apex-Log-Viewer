#!/usr/bin/env node
'use strict';

const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('path');
const spawn = require('cross-spawn');

const REPO_ROOT = path.join(__dirname, '..');
const SLOT_KEY_WIDTH = 2;
const DEFAULT_SLOT_KEY_PREFIX = 'slot';
const DEFAULT_SLOT_ALIAS_PREFIX = 'ALV_E2E_POOL';
const DEFAULT_API_VERSION = '66.0';
const orgDisplayCache = new Map();

function getCommand(argv = process.argv.slice(2)) {
  return argv.find(arg => !arg.startsWith('-')) || '';
}

function getArgValue(name, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const direct = argv.find(arg => arg.startsWith(prefix));
  if (direct) {
    return direct.slice(prefix.length);
  }

  const index = argv.findIndex(arg => arg === `--${name}`);
  if (index >= 0 && index + 1 < argv.length) {
    return argv[index + 1];
  }

  return '';
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function hasOption(name, argv = process.argv.slice(2)) {
  const flag = `--${name}`;
  const prefix = `${flag}=`;
  return argv.includes(flag) || argv.some(arg => arg.startsWith(prefix));
}

function resolveTargetOrg(argv = process.argv.slice(2)) {
  return (
    getArgValue('target-org', argv) ||
    String(process.env.SF_DEVHUB_ALIAS || '').trim()
  );
}

function escapeSoqlLiteral(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatSfValue(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const normalized = String(value);
  return `'${normalized.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function toSfValuesArgument(fields) {
  return Object.entries(fields)
    .map(([key, value]) => {
      const formatted = formatSfValue(value);
      return formatted === undefined ? '' : `${key}=${formatted}`;
    })
    .filter(Boolean)
    .join(' ');
}

function toRestRecordPayload(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

function buildSlotDescriptors({
  targetSize,
  slotKeyPrefix = DEFAULT_SLOT_KEY_PREFIX,
  scratchAliasPrefix = DEFAULT_SLOT_ALIAS_PREFIX
}) {
  const descriptors = [];
  for (let index = 1; index <= targetSize; index += 1) {
    const suffix = String(index).padStart(SLOT_KEY_WIDTH, '0');
    descriptors.push({
      slotKey: `${slotKeyPrefix}-${suffix}`,
      scratchAlias: `${scratchAliasPrefix}_${suffix}`
    });
  }
  return descriptors;
}

function toScratchExpirationDateTimeValue(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes('T')) {
    return normalized;
  }
  return `${normalized}T23:59:59.000Z`;
}

function truncateLongText(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value);
  return normalized.length <= 32768 ? normalized : normalized.slice(0, 32768);
}

function parseInteger(value, fallbackValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallbackValue;
}

function normalizePoolConfig(argv = process.argv.slice(2)) {
  const snapshotName = getArgValue('snapshot-name', argv);
  const definitionHash = getArgValue('definition-hash', argv);
  const seedVersion = getArgValue('seed-version', argv);
  return {
    poolKey: getArgValue('pool-key', argv) || getArgValue('pool', argv),
    enabled: !hasFlag('disabled', argv),
    targetSize: Math.max(1, parseInteger(getArgValue('target-size', argv) || '21', 21)),
    scratchDurationDays: Math.max(1, parseInteger(getArgValue('scratch-duration-days', argv) || '30', 30)),
    leaseTtlSeconds: Math.max(60, parseInteger(getArgValue('lease-ttl-seconds', argv) || '5400', 5400)),
    acquireTimeoutSeconds: Math.max(30, parseInteger(getArgValue('acquire-timeout-seconds', argv) || '600', 600)),
    minRemainingMinutes: Math.max(0, parseInteger(getArgValue('min-remaining-minutes', argv) || '120', 120)),
    provisioningMode: getArgValue('provisioning-mode', argv) || 'definition',
    snapshotName: snapshotName || null,
    definitionHash: definitionHash || null,
    seedVersion: seedVersion || 'alv-e2e-baseline-v1',
    snapshotNameSpecified: hasOption('snapshot-name', argv),
    definitionHashSpecified: hasOption('definition-hash', argv),
    seedVersionSpecified: hasOption('seed-version', argv),
    slotKeyPrefix: getArgValue('slot-key-prefix', argv) || DEFAULT_SLOT_KEY_PREFIX,
    scratchAliasPrefix: getArgValue('slot-alias-prefix', argv) || DEFAULT_SLOT_ALIAS_PREFIX
  };
}

function normalizePrewarmOptions(argv = process.argv.slice(2)) {
  const limit = parseInteger(getArgValue('limit', argv), 0);
  return {
    limit: limit > 0 ? limit : undefined
  };
}

function execFileAsync(file, args, options = {}) {
  const { cwd = REPO_ROOT, spawnImpl = spawn, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let didTimeout = false;
    let timeoutHandle;
    let timeoutError;

    const settle = callback => value => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      callback(value);
    };

    const resolveOnce = settle(resolve);
    const rejectOnce = settle(reject);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        timeoutError = new Error(`Command timed out after ${timeoutMs}ms: ${file} ${args.join(' ')}`.trim());
        try {
          child.kill?.();
        } catch {
          // Best effort only; the timeout should still reject promptly.
        }
        rejectOnce(timeoutError);
      }, timeoutMs);
    }

    child.on('error', error => {
      const message = String(stderr || stdout || error.message || 'Command failed').trim();
      rejectOnce(new Error(message));
    });

    child.on('close', code => {
      if (didTimeout && timeoutError) {
        rejectOnce(timeoutError);
        return;
      }
      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }
      const message = String(stderr || stdout || `Command failed with exit code ${code}.`).trim();
      rejectOnce(new Error(message));
    });
  });
}

async function runSfJson(args, options = {}) {
  const executable = process.platform === 'win32' ? 'sf.cmd' : 'sf';
  const finalArgs = [...args, '--json'];
  const { stdout } = await execFileAsync(executable, finalArgs, options);
  const parsed = JSON.parse(stdout || '{}');
  if (parsed && typeof parsed.status === 'number' && parsed.status !== 0) {
    throw new Error(parsed.message || `Salesforce CLI exited with status ${parsed.status}.`);
  }
  return parsed;
}

async function queryRecords(targetOrg, soql) {
  const response = await runSfJson(['data', 'query', '--target-org', targetOrg, '--query', soql]);
  return Array.isArray(response?.result?.records) ? response.result.records : [];
}

async function getOrgDisplay(targetOrg) {
  if (orgDisplayCache.has(targetOrg)) {
    return orgDisplayCache.get(targetOrg);
  }

  const response = await runSfJson(['org', 'display', '--target-org', targetOrg]);
  const result = response?.result || {};
  if (!result.instanceUrl || !result.accessToken) {
    throw new Error(`Could not resolve authenticated org details for '${targetOrg}'.`);
  }

  const connection = {
    accessToken: result.accessToken,
    apiVersion: result.apiVersion || DEFAULT_API_VERSION,
    instanceUrl: String(result.instanceUrl).replace(/\/+$/, '')
  };
  orgDisplayCache.set(targetOrg, connection);
  return connection;
}

class ConditionalUpdateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConditionalUpdateConflictError';
  }
}

function toHttpDateString(value) {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toUTCString();
}

async function callSalesforceRest(targetOrg, method, resourcePath, body, options = {}) {
  const connection = await getOrgDisplay(targetOrg);
  const response = await fetch(
    `${connection.instanceUrl}/services/data/v${connection.apiVersion}${resourcePath}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  );

  if (response.status === 204) {
    return undefined;
  }

  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : undefined;
  if (!response.ok) {
    if (response.status === 412) {
      throw new ConditionalUpdateConflictError(raw || 'Record changed before the update could be applied.');
    }
    const details = Array.isArray(parsed)
      ? parsed.map(item => `${item.errorCode}: ${item.message}`).join('; ')
      : raw || `HTTP ${response.status}`;
    throw new Error(details);
  }

  return parsed;
}

async function createRecord(targetOrg, sobject, fields) {
  const result = await callSalesforceRest(
    targetOrg,
    'POST',
    `/sobjects/${encodeURIComponent(sobject)}`,
    toRestRecordPayload(fields)
  );
  return { result };
}

async function updateRecord(targetOrg, sobject, recordId, fields, options = {}) {
  const payload = toRestRecordPayload(fields);
  if (Object.keys(payload).length === 0) {
    return undefined;
  }
  const conditionalHeaders = {};
  const ifUnmodifiedSince = toHttpDateString(options.ifUnmodifiedSince);
  if (ifUnmodifiedSince) {
    conditionalHeaders['If-Unmodified-Since'] = ifUnmodifiedSince;
  }
  await callSalesforceRest(
    targetOrg,
    'PATCH',
    `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(recordId)}`,
    payload,
    Object.keys(conditionalHeaders).length > 0 ? { headers: conditionalHeaders } : undefined
  );
  return undefined;
}

function buildBaseScratchDefinition(options = {}) {
  if (options.snapshotName) {
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

function buildPoolScratchDefinition({ poolKey, slotKey, definitionHash, seedVersion, snapshotName }) {
  return {
    ...buildBaseScratchDefinition({ snapshotName }),
    alvPoolKey__c: poolKey,
    alvSlotKey__c: slotKey,
    alvDefinitionHash__c: definitionHash,
    alvSeedVersion__c: seedVersion
  };
}

async function createScratchProjectContext(definition) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'alv-scratch-prewarm-'));
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
    cleanup: async () => {
      try {
        await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      } catch {
        // Best-effort cleanup on Windows.
      }
    }
  };
}

async function getAuthenticatedOrgDisplay(targetOrg, options = {}) {
  const args = ['org', 'display', '--target-org', targetOrg];
  if (options.verbose) {
    args.push('--verbose');
  }
  const response = await runSfJson(args);
  return response?.result || {};
}

async function getScratchAuthUrlOrThrow(scratchAlias) {
  const display = await getAuthenticatedOrgDisplay(scratchAlias, { verbose: true });
  const scratchAuthUrl = String(display.sfdxAuthUrl || '').trim();
  if (!scratchAuthUrl) {
    throw new Error(`Scratch org '${scratchAlias}' did not return an sfdxAuthUrl.`);
  }
  return scratchAuthUrl;
}

async function clearStaleScratchOrg(alias) {
  if (!alias) {
    return;
  }

  try {
    await runSfJson(['org', 'logout', '--target-org', alias, '--no-prompt']);
  } catch {
    // Best-effort cleanup.
  }

  try {
    await runSfJson(['alias', 'unset', alias]);
  } catch {
    // Best-effort cleanup.
  }
}

async function waitForScratchOrgReady(targetOrg) {
  const timeoutMs = 240_000;
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
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
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || '');
  throw new Error(`Scratch org '${targetOrg}' was not ready after ${timeoutMs}ms. ${detail}`.trim());
}

function createMaintenanceLeaseToken(slotKey) {
  return `prewarm-${slotKey}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function createMaintenanceOwnerLabel() {
  return `prewarm:${process.pid}`;
}

function isDeleteNotFoundError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('ENTITY_IS_DELETED') ||
    message.includes('NOT_FOUND') ||
    message.includes('NOT_FOUND_ERROR')
  );
}

async function deleteExistingScratchForSlot(targetOrg, poolKey, slot, dependencies = {}) {
  const getLatestScratchOrgInfoImpl = dependencies.getLatestScratchOrgInfo || getLatestScratchOrgInfo;
  const getActiveScratchOrgByInfoIdImpl = dependencies.getActiveScratchOrgByInfoId || getActiveScratchOrgByInfoId;
  const callSalesforceRestImpl = dependencies.callSalesforceRest || callSalesforceRest;
  const isDeleteNotFoundErrorImpl = dependencies.isDeleteNotFoundError || isDeleteNotFoundError;
  const latestInfo = slot.ScratchOrgInfoId__c
    ? { Id: slot.ScratchOrgInfoId__c }
    : await getLatestScratchOrgInfoImpl(targetOrg, poolKey, slot.SlotKey__c);
  const activeScratch = slot.ActiveScratchOrgId__c
    ? { Id: slot.ActiveScratchOrgId__c }
    : await getActiveScratchOrgByInfoIdImpl(targetOrg, latestInfo?.Id);

  if (activeScratch?.Id) {
    try {
      await callSalesforceRestImpl(
        targetOrg,
        'DELETE',
        `/sobjects/ActiveScratchOrg/${encodeURIComponent(activeScratch.Id)}`
      );
      return;
    } catch (error) {
      if (!isDeleteNotFoundErrorImpl(error)) {
        throw error;
      }
    }
  }

  if (!latestInfo?.Id) {
    return;
  }

  try {
    await callSalesforceRestImpl(
      targetOrg,
      'DELETE',
      `/sobjects/ScratchOrgInfo/${encodeURIComponent(latestInfo.Id)}`
    );
  } catch (error) {
    if (!isDeleteNotFoundErrorImpl(error)) {
      throw error;
    }
  }
}

async function getPoolByKey(targetOrg, poolKey) {
  const records = await queryRecords(
    targetOrg,
    [
      'SELECT Id, PoolKey__c, Enabled__c, TargetSize__c, ScratchDurationDays__c, LeaseTtlSeconds__c,',
      'AcquireTimeoutSeconds__c, MinRemainingMinutes__c, ProvisioningMode__c, SnapshotName__c, DefinitionHash__c, SeedVersion__c',
      `FROM ALV_ScratchOrgPool__c WHERE PoolKey__c = '${escapeSoqlLiteral(poolKey)}' LIMIT 1`
    ].join(' ')
  );
  return records[0];
}

async function getSlotsByPoolId(targetOrg, poolId) {
  return await queryRecords(
    targetOrg,
    [
      'SELECT Id, SlotKey__c, ScratchAlias__c, LeaseState__c, LeaseOwner__c, LeaseToken__c, LeaseExpiresAt__c,',
      'LastHeartbeatAt__c, LastLeaseStartedAt__c, LastLeaseReleasedAt__c, LastRunResult__c, HealthState__c,',
      'ScratchUsername__c, ScratchLoginUrl__c, ScratchOrgId__c, ScratchOrgInfoId__c, ActiveScratchOrgId__c, ScratchExpiresAt__c,',
      'DefinitionHash__c, SeedVersion__c, UsageCount__c, LastError__c',
      `FROM ALV_ScratchOrgPoolSlot__c WHERE Pool__c = '${escapeSoqlLiteral(poolId)}' ORDER BY SlotKey__c`
    ].join(' ')
  );
}

async function getSlotByKey(targetOrg, poolKey, slotKey) {
  const records = await queryRecords(
    targetOrg,
    [
      'SELECT Id, LastModifiedDate, SlotKey__c, ScratchAlias__c, LeaseState__c, LeaseOwner__c, LeaseToken__c, LeaseExpiresAt__c,',
      'LastHeartbeatAt__c, LastLeaseStartedAt__c, LastLeaseReleasedAt__c, LastRunResult__c, HealthState__c,',
      'ScratchUsername__c, ScratchLoginUrl__c, ScratchAuthUrl__c, ScratchOrgId__c, ScratchOrgInfoId__c, ActiveScratchOrgId__c, ScratchExpiresAt__c,',
      'DefinitionHash__c, SeedVersion__c, UsageCount__c, LastError__c, Pool__c, Pool__r.PoolKey__c, Pool__r.DefinitionHash__c, Pool__r.SeedVersion__c',
      `FROM ALV_ScratchOrgPoolSlot__c WHERE Pool__r.PoolKey__c = '${escapeSoqlLiteral(poolKey)}' AND SlotKey__c = '${escapeSoqlLiteral(slotKey)}' LIMIT 1`
    ].join(' ')
  );
  return records[0];
}

async function getSlotsByPoolIdForMaintenance(targetOrg, poolId) {
  return await queryRecords(
    targetOrg,
    [
      'SELECT Id, SlotKey__c, ScratchAlias__c, LeaseState__c, LeaseOwner__c, LeaseToken__c, LeaseExpiresAt__c,',
      'LastHeartbeatAt__c, LastLeaseStartedAt__c, LastLeaseReleasedAt__c, LastRunResult__c, HealthState__c,',
      'ScratchUsername__c, ScratchLoginUrl__c, ScratchAuthUrl__c, ScratchOrgId__c, ScratchOrgInfoId__c, ActiveScratchOrgId__c, ScratchExpiresAt__c,',
      'DefinitionHash__c, SeedVersion__c, UsageCount__c, LastError__c',
      `FROM ALV_ScratchOrgPoolSlot__c WHERE Pool__c = '${escapeSoqlLiteral(poolId)}' ORDER BY SlotKey__c`
    ].join(' ')
  );
}

async function getLatestScratchOrgInfo(targetOrg, poolKey, slotKey) {
  const records = await queryRecords(
    targetOrg,
    [
      'SELECT Id, ScratchOrg, SignupUsername, LoginUrl, ExpirationDate, Status, alvDefinitionHash__c, alvSeedVersion__c',
      'FROM ScratchOrgInfo',
      `WHERE alvPoolKey__c = '${escapeSoqlLiteral(poolKey)}' AND alvSlotKey__c = '${escapeSoqlLiteral(slotKey)}'`,
      'ORDER BY CreatedDate DESC LIMIT 1'
    ].join(' ')
  );
  return records[0];
}

async function getActiveScratchOrgByInfoId(targetOrg, scratchOrgInfoId) {
  if (!scratchOrgInfoId) {
    return undefined;
  }
  const records = await queryRecords(
    targetOrg,
    [
      'SELECT Id, ScratchOrg, SignupUsername, ExpirationDate, ScratchOrgInfoId',
      'FROM ActiveScratchOrg',
      `WHERE ScratchOrgInfoId = '${escapeSoqlLiteral(scratchOrgInfoId)}' LIMIT 1`
    ].join(' ')
  );
  return records[0];
}

async function bootstrapPool(targetOrg, config, dependencies = {}) {
  const getPoolByKeyImpl = dependencies.getPoolByKey || getPoolByKey;
  const getSlotsByPoolIdImpl = dependencies.getSlotsByPoolId || getSlotsByPoolId;
  const createRecordImpl = dependencies.createRecord || createRecord;
  const updateRecordImpl = dependencies.updateRecord || updateRecord;
  const deleteExistingScratchForSlotImpl =
    dependencies.deleteExistingScratchForSlot || deleteExistingScratchForSlot;

  let pool = await getPoolByKeyImpl(targetOrg, config.poolKey);
  const defaultSeedVersion = config.seedVersion || 'alv-e2e-baseline-v1';
  const createPoolValues = {
    PoolKey__c: config.poolKey,
    Enabled__c: config.enabled,
    TargetSize__c: config.targetSize,
    ScratchDurationDays__c: config.scratchDurationDays,
    LeaseTtlSeconds__c: config.leaseTtlSeconds,
    AcquireTimeoutSeconds__c: config.acquireTimeoutSeconds,
    MinRemainingMinutes__c: config.minRemainingMinutes,
    ProvisioningMode__c: config.provisioningMode,
    SnapshotName__c: config.snapshotName,
    DefinitionHash__c: config.definitionHash,
    SeedVersion__c: defaultSeedVersion
  };
  const updatePoolValues = {
    PoolKey__c: config.poolKey,
    Enabled__c: config.enabled,
    TargetSize__c: config.targetSize,
    ScratchDurationDays__c: config.scratchDurationDays,
    LeaseTtlSeconds__c: config.leaseTtlSeconds,
    AcquireTimeoutSeconds__c: config.acquireTimeoutSeconds,
    MinRemainingMinutes__c: config.minRemainingMinutes,
    ProvisioningMode__c: config.provisioningMode,
    ...(config.snapshotNameSpecified ? { SnapshotName__c: config.snapshotName } : {}),
    ...(config.definitionHashSpecified ? { DefinitionHash__c: config.definitionHash } : {}),
    ...(config.seedVersionSpecified ? { SeedVersion__c: defaultSeedVersion } : {})
  };

  let createdPool = false;
  if (!pool) {
    const createResult = await createRecordImpl(targetOrg, 'ALV_ScratchOrgPool__c', createPoolValues);
    const poolId = createResult?.result?.id || createResult?.result?.Id;
    if (!poolId) {
      throw new Error(`Failed to create scratch pool '${config.poolKey}'.`);
    }
    createdPool = true;
    pool = await getPoolByKeyImpl(targetOrg, config.poolKey);
  } else {
    await updateRecordImpl(targetOrg, 'ALV_ScratchOrgPool__c', pool.Id, updatePoolValues);
    pool = await getPoolByKeyImpl(targetOrg, config.poolKey);
  }

  if (!pool?.Id) {
    throw new Error(`Scratch pool '${config.poolKey}' could not be loaded after bootstrap.`);
  }

  const existingSlots = await getSlotsByPoolIdImpl(targetOrg, pool.Id);
  const existingSlotsByKey = new Map(
    existingSlots.map(slot => [String(slot.SlotKey__c || ''), slot])
  );
  const desiredDescriptors = buildSlotDescriptors(config);
  const desiredSlotKeys = new Set(desiredDescriptors.map(descriptor => descriptor.slotKey));
  const createdSlotKeys = [];
  const updatedSlotKeys = [];
  const disabledSlotKeys = [];

  for (const descriptor of desiredDescriptors) {
    const existingSlot = existingSlotsByKey.get(descriptor.slotKey);
    if (existingSlot) {
      await updateRecordImpl(targetOrg, 'ALV_ScratchOrgPoolSlot__c', existingSlot.Id, {
        ScratchAlias__c: descriptor.scratchAlias
      });
      updatedSlotKeys.push(descriptor.slotKey);
      continue;
    }
    await createRecordImpl(targetOrg, 'ALV_ScratchOrgPoolSlot__c', {
      Pool__c: pool.Id,
      SlotKey__c: descriptor.slotKey,
      ScratchAlias__c: descriptor.scratchAlias,
      LeaseState__c: 'available',
      HealthState__c: 'needs_recreate',
      DefinitionHash__c: pool.DefinitionHash__c || config.definitionHash,
      SeedVersion__c: pool.SeedVersion__c || defaultSeedVersion
    });
    createdSlotKeys.push(descriptor.slotKey);
  }

  for (const existingSlot of existingSlots) {
    const slotKey = String(existingSlot.SlotKey__c || '').trim();
    if (!slotKey || desiredSlotKeys.has(slotKey)) {
      continue;
    }

    const leaseState = String(existingSlot.LeaseState__c || '').trim().toLowerCase();
    if (leaseState === 'leased' || leaseState === 'provisioning') {
      throw new Error(
        `Cannot shrink scratch pool '${config.poolKey}' while slot '${slotKey}' is ${existingSlot.LeaseState__c || 'in use'}.`
      );
    }

    await deleteExistingScratchForSlotImpl(targetOrg, config.poolKey, existingSlot);
    await updateRecordImpl(targetOrg, 'ALV_ScratchOrgPoolSlot__c', existingSlot.Id, {
      LeaseState__c: 'disabled',
      LeaseOwner__c: null,
      LeaseToken__c: null,
      LeaseExpiresAt__c: null,
      ScratchUsername__c: null,
      ScratchLoginUrl__c: null,
      ScratchAuthUrl__c: null,
      ScratchOrgId__c: null,
      ScratchOrgInfoId__c: null,
      ActiveScratchOrgId__c: null,
      ScratchExpiresAt__c: null,
      HealthState__c: 'needs_recreate',
      LastError__c: truncateLongText(`Slot disabled because pool target size was reduced to ${config.targetSize}.`)
    });
    disabledSlotKeys.push(slotKey);
  }

  return {
    ok: true,
    command: 'bootstrap',
    poolKey: config.poolKey,
    poolId: pool.Id,
    createdPool,
    targetSize: config.targetSize,
    existingSlotCount: existingSlots.length,
    createdSlotKeys,
    updatedSlotKeys,
    disabledSlotKeys
  };
}

async function listPool(targetOrg, poolKey) {
  const pool = await getPoolByKey(targetOrg, poolKey);
  if (!pool?.Id) {
    throw new Error(`Scratch pool '${poolKey}' was not found.`);
  }
  const slots = await getSlotsByPoolId(targetOrg, pool.Id);
  return {
    ok: true,
    command: 'list',
    pool,
    slots
  };
}

async function reconcilePool(targetOrg, poolKey) {
  const pool = await getPoolByKey(targetOrg, poolKey);
  if (!pool?.Id) {
    throw new Error(`Scratch pool '${poolKey}' was not found.`);
  }

  const slots = await getSlotsByPoolIdForMaintenance(targetOrg, pool.Id);
  let healthySlots = 0;
  let needsRecreateSlots = 0;

  for (const slot of slots) {
    const info = await getLatestScratchOrgInfo(targetOrg, poolKey, slot.SlotKey__c);
    const active = await getActiveScratchOrgByInfoId(targetOrg, info?.Id);
    const hasActiveScratch = Boolean(active?.Id);
    const hasScratchAuthUrl = Boolean(String(slot.ScratchAuthUrl__c || '').trim());
    const healthState = hasActiveScratch && hasScratchAuthUrl ? 'healthy' : 'needs_recreate';

    if (healthState === 'healthy') {
      healthySlots += 1;
    } else {
      needsRecreateSlots += 1;
    }

    await updateRecord(targetOrg, 'ALV_ScratchOrgPoolSlot__c', slot.Id, {
      ScratchOrgInfoId__c: info?.Id || null,
      ScratchOrgId__c: active?.ScratchOrg || info?.ScratchOrg || null,
      ScratchUsername__c: active?.SignupUsername || info?.SignupUsername || null,
      ScratchLoginUrl__c: info?.LoginUrl || null,
      ActiveScratchOrgId__c: active?.Id || null,
      ScratchExpiresAt__c: toScratchExpirationDateTimeValue(active?.ExpirationDate || info?.ExpirationDate),
      DefinitionHash__c: info?.alvDefinitionHash__c || pool.DefinitionHash__c || slot.DefinitionHash__c || null,
      SeedVersion__c: info?.alvSeedVersion__c || pool.SeedVersion__c || slot.SeedVersion__c || null,
      HealthState__c: healthState,
      LastError__c: healthState === 'healthy'
        ? null
        : !hasScratchAuthUrl
          ? 'Slot has no stored scratch auth URL and must be recreated.'
          : info?.Id
            ? `ScratchOrgInfo ${info.Id} no longer has an ActiveScratchOrg.`
            : 'No ScratchOrgInfo found for this slot.'
    });
  }

  return {
    ok: true,
    command: 'reconcile',
    poolKey,
    slotCount: slots.length,
    healthySlots,
    needsRecreateSlots
  };
}

async function disableSlot(targetOrg, poolKey, slotKey, reason) {
  const slot = await getSlotByKey(targetOrg, poolKey, slotKey);
  if (!slot?.Id) {
    throw new Error(`Scratch pool slot '${slotKey}' was not found in pool '${poolKey}'.`);
  }
  await updateRecord(targetOrg, 'ALV_ScratchOrgPoolSlot__c', slot.Id, {
    LeaseState__c: 'disabled',
    LeaseOwner__c: null,
    LeaseToken__c: null,
    LeaseExpiresAt__c: null,
    LastError__c: reason || 'Slot disabled manually.'
  });
  return {
    ok: true,
    command: 'disable-slot',
    poolKey,
    slotKey
  };
}

async function resetSlot(targetOrg, poolKey, slotKey, reason) {
  const slot = await getSlotByKey(targetOrg, poolKey, slotKey);
  if (!slot?.Id) {
    throw new Error(`Scratch pool slot '${slotKey}' was not found in pool '${poolKey}'.`);
  }
  await updateRecord(targetOrg, 'ALV_ScratchOrgPoolSlot__c', slot.Id, {
    LeaseState__c: 'available',
    LeaseOwner__c: null,
    LeaseToken__c: null,
    LeaseExpiresAt__c: null,
    ScratchUsername__c: null,
    ScratchLoginUrl__c: null,
    ScratchAuthUrl__c: null,
    ScratchOrgId__c: null,
    ScratchOrgInfoId__c: null,
    ActiveScratchOrgId__c: null,
    ScratchExpiresAt__c: null,
    DefinitionHash__c: slot.Pool__r?.DefinitionHash__c || null,
    SeedVersion__c: slot.Pool__r?.SeedVersion__c || null,
    HealthState__c: 'needs_recreate',
    LastError__c: reason || 'Slot reset manually.'
  });
  return {
    ok: true,
    command: 'reset-slot',
    poolKey,
    slotKey
  };
}

async function prewarmSlot(targetOrg, pool, slot) {
  const refreshedSlot = await getSlotByKey(targetOrg, pool.PoolKey__c, slot.SlotKey__c);
  if (!refreshedSlot?.Id) {
    return {
      slotKey: slot.SlotKey__c,
      scratchAlias: slot.ScratchAlias__c,
      skipped: true,
      skipReason: 'slot no longer exists'
    };
  }

  if (!isSlotEligibleForPrewarm(refreshedSlot)) {
    return {
      slotKey: refreshedSlot.SlotKey__c,
      scratchAlias: refreshedSlot.ScratchAlias__c,
      skipped: true,
      skipReason: `slot is currently '${refreshedSlot.LeaseState__c || 'unavailable'}'`
    };
  }

  const startedAt = new Date().toISOString();
  const leaseToken = createMaintenanceLeaseToken(slot.SlotKey__c);
  const maintenanceOwner = createMaintenanceOwnerLabel();

  try {
    await updateRecord(
      targetOrg,
      'ALV_ScratchOrgPoolSlot__c',
      refreshedSlot.Id,
      {
        LeaseState__c: 'provisioning',
        LeaseOwner__c: maintenanceOwner,
        LeaseToken__c: leaseToken,
        LeaseExpiresAt__c: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        LastLeaseStartedAt__c: startedAt,
        LastError__c: null
      },
      { ifUnmodifiedSince: refreshedSlot.LastModifiedDate }
    );
  } catch (error) {
    if (error instanceof ConditionalUpdateConflictError) {
      return {
        slotKey: refreshedSlot.SlotKey__c,
        scratchAlias: refreshedSlot.ScratchAlias__c,
        skipped: true,
        skipReason: 'slot changed while prewarm was taking the lease'
      };
    }
    throw error;
  }

  try {
    await deleteExistingScratchForSlot(targetOrg, pool.PoolKey__c, refreshedSlot);
    await clearStaleScratchOrg(refreshedSlot.ScratchAlias__c);

    const definition = buildPoolScratchDefinition({
      poolKey: pool.PoolKey__c,
      slotKey: refreshedSlot.SlotKey__c,
      definitionHash: pool.DefinitionHash__c || refreshedSlot.DefinitionHash__c || null,
      seedVersion: pool.SeedVersion__c || refreshedSlot.SeedVersion__c || 'alv-e2e-baseline-v1',
      snapshotName: pool.SnapshotName__c || undefined
    });
    const context = await createScratchProjectContext(definition);
    try {
      await runSfJson(
        [
          'org',
          'create',
          'scratch',
          '--target-dev-hub',
          targetOrg,
          '--alias',
          refreshedSlot.ScratchAlias__c,
          '--definition-file',
          context.defFile,
          '--duration-days',
          String(parseInteger(pool.ScratchDurationDays__c, 30) || 30),
          '--wait',
          '15'
        ],
        { cwd: context.cwd, timeoutMs: 20 * 60 * 1000 }
      );
    } finally {
      await context.cleanup();
    }

    await waitForScratchOrgReady(refreshedSlot.ScratchAlias__c);
    const scratchAuthUrl = await getScratchAuthUrlOrThrow(refreshedSlot.ScratchAlias__c);
    const info = await getLatestScratchOrgInfo(targetOrg, pool.PoolKey__c, refreshedSlot.SlotKey__c);
    if (!info?.Id) {
      throw new Error(`No ScratchOrgInfo was found for slot '${refreshedSlot.SlotKey__c}' after prewarm.`);
    }
    const active = await getActiveScratchOrgByInfoId(targetOrg, info.Id);
    const completedAt = new Date().toISOString();

    await updateRecord(targetOrg, 'ALV_ScratchOrgPoolSlot__c', refreshedSlot.Id, {
      LeaseState__c: 'available',
      LeaseOwner__c: null,
      LeaseToken__c: null,
      LeaseExpiresAt__c: null,
      LastHeartbeatAt__c: completedAt,
      LastLeaseReleasedAt__c: completedAt,
      LastRunResult__c: 'prewarmed',
      HealthState__c: 'healthy',
      ScratchUsername__c: active?.SignupUsername || info.SignupUsername || null,
      ScratchLoginUrl__c: info.LoginUrl || null,
      ScratchAuthUrl__c: scratchAuthUrl,
      ScratchOrgId__c: active?.ScratchOrg || info.ScratchOrg || null,
      ScratchOrgInfoId__c: info.Id,
      ActiveScratchOrgId__c: active?.Id || null,
      ScratchExpiresAt__c: toScratchExpirationDateTimeValue(active?.ExpirationDate || info.ExpirationDate),
      DefinitionHash__c: info.alvDefinitionHash__c || pool.DefinitionHash__c || refreshedSlot.DefinitionHash__c || null,
      SeedVersion__c: info.alvSeedVersion__c || pool.SeedVersion__c || refreshedSlot.SeedVersion__c || null,
      LastError__c: null
    });

    return {
      slotKey: refreshedSlot.SlotKey__c,
      scratchAlias: refreshedSlot.ScratchAlias__c,
      scratchOrgInfoId: info.Id,
      activeScratchOrgId: active?.Id || null
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    await clearStaleScratchOrg(refreshedSlot.ScratchAlias__c);
    await updateRecord(targetOrg, 'ALV_ScratchOrgPoolSlot__c', refreshedSlot.Id, {
      LeaseState__c: 'available',
      LeaseOwner__c: null,
      LeaseToken__c: null,
      LeaseExpiresAt__c: null,
      LastHeartbeatAt__c: completedAt,
      LastLeaseReleasedAt__c: completedAt,
      LastRunResult__c: 'prewarm_failed',
      HealthState__c: 'needs_recreate',
      ScratchUsername__c: null,
      ScratchLoginUrl__c: null,
      ScratchAuthUrl__c: null,
      ScratchOrgId__c: null,
      ScratchOrgInfoId__c: null,
      ActiveScratchOrgId__c: null,
      ScratchExpiresAt__c: null,
      LastError__c: truncateLongText(error instanceof Error ? error.message : String(error))
    });
    throw error;
  }
}

async function prewarmPool(targetOrg, poolKey, options = {}) {
  const pool = await getPoolByKey(targetOrg, poolKey);
  if (!pool?.Id) {
    throw new Error(`Scratch pool '${poolKey}' was not found.`);
  }

  const slots = await getSlotsByPoolIdForMaintenance(targetOrg, pool.Id);
  const healthySlots = [];
  const slotsToPrewarm = [];

  for (const slot of slots) {
    const hasAuthUrl = Boolean(String(slot.ScratchAuthUrl__c || '').trim());
    const isHealthy = slot.HealthState__c === 'healthy' && hasAuthUrl && slot.LeaseState__c === 'available';
    if (isHealthy) {
      healthySlots.push(slot.SlotKey__c);
      continue;
    }
    if (!isSlotEligibleForPrewarm(slot)) {
      continue;
    }
    slotsToPrewarm.push(slot);
  }

  const limit = options.limit ? Math.max(1, options.limit) : slotsToPrewarm.length;
  const selectedSlots = slotsToPrewarm.slice(0, limit);
  const prewarmedSlotKeys = [];

  for (const slot of selectedSlots) {
    console.log(`[scratch-pool] prewarming ${slot.SlotKey__c} (${slot.ScratchAlias__c})...`);
    const result = await prewarmSlot(targetOrg, pool, slot);
    if (result.skipped) {
      console.log(`[scratch-pool] skipped ${result.slotKey} (${result.scratchAlias}): ${result.skipReason}.`);
      continue;
    }
    prewarmedSlotKeys.push(result.slotKey);
    console.log(`[scratch-pool] prewarmed ${result.slotKey} (${result.scratchAlias}).`);
  }

  const refreshedSlots = await getSlotsByPoolIdForMaintenance(targetOrg, pool.Id);
  const finalHealthySlots = refreshedSlots.filter(
    slot => slot.HealthState__c === 'healthy' && String(slot.ScratchAuthUrl__c || '').trim()
  );
  const finalNeedsRecreateSlots = refreshedSlots.filter(
    slot => slot.HealthState__c === 'needs_recreate' || !String(slot.ScratchAuthUrl__c || '').trim()
  );

  return {
    ok: true,
    command: 'prewarm',
    poolKey,
    requestedLimit: options.limit || null,
    skippedHealthySlotKeys: healthySlots,
    prewarmedSlotKeys,
    healthySlotCount: finalHealthySlots.length,
    needsRecreateSlotCount: finalNeedsRecreateSlots.length,
    remainingNeedsRecreateSlotKeys: finalNeedsRecreateSlots.map(slot => slot.SlotKey__c)
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/scratch-pool-admin.js bootstrap --pool-key <pool> [--target-org <alias>]
  node scripts/scratch-pool-admin.js list --pool-key <pool> [--target-org <alias>] [--json]
  node scripts/scratch-pool-admin.js reconcile --pool-key <pool> [--target-org <alias>] [--json]
  node scripts/scratch-pool-admin.js prewarm --pool-key <pool> [--limit <n>] [--target-org <alias>] [--json]
  node scripts/scratch-pool-admin.js disable-slot --pool-key <pool> --slot-key <slot> [--reason <text>] [--target-org <alias>] [--json]
  node scripts/scratch-pool-admin.js reset-slot --pool-key <pool> --slot-key <slot> [--reason <text>] [--target-org <alias>] [--json]

Bootstrap options:
  --target-size <n>                Number of logical slots to maintain. Default: 21
  --scratch-duration-days <n>      Scratch org lifetime in days. Default: 30
  --lease-ttl-seconds <n>          Lease TTL in seconds. Default: 5400
  --acquire-timeout-seconds <n>    Acquire timeout in seconds. Default: 600
  --min-remaining-minutes <n>      Minimum remaining scratch lifetime to allow reuse. Default: 120
  --provisioning-mode <mode>       definition or snapshot. Default: definition
  --snapshot-name <name>           Snapshot name when provisioning-mode=snapshot
  --definition-hash <hash>         Baseline hash stored on the pool and new slots
  --seed-version <version>         Seed version stored on the pool and new slots. Default: alv-e2e-baseline-v1
  --slot-key-prefix <prefix>       Slot key prefix. Default: slot
  --slot-alias-prefix <prefix>     Scratch alias prefix. Default: ALV_E2E_POOL
  --disabled                       Bootstrap the pool with Enabled__c=false

Prewarm options:
  --limit <n>                      Maximum number of non-healthy slots to prewarm in this run. Default: all pending slots

General notes:
  - Authenticate the Dev Hub first, then pass --target-org or set SF_DEVHUB_ALIAS.
  - Use --json for machine-readable output.
`);
}

function renderResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.command === 'list') {
    console.log(`Pool ${result.pool.PoolKey__c} (${result.pool.Id})`);
    console.table(
      result.slots.map(slot => ({
        slotKey: slot.SlotKey__c,
        alias: slot.ScratchAlias__c,
        leaseState: slot.LeaseState__c,
        health: slot.HealthState__c,
        scratchUsername: slot.ScratchUsername__c,
        scratchExpiresAt: slot.ScratchExpiresAt__c,
        usageCount: slot.UsageCount__c
      }))
    );
    return;
  }

  if (result.command === 'prewarm') {
    console.log(`Pool ${result.poolKey}`);
    console.log(`Prewarmed slots: ${result.prewarmedSlotKeys.length}`);
    console.log(`Healthy slots: ${result.healthySlotCount}`);
    console.log(`Needs recreate: ${result.needsRecreateSlotCount}`);
    if (result.remainingNeedsRecreateSlotKeys.length > 0) {
      console.log(`Remaining slots: ${result.remainingNeedsRecreateSlotKeys.join(', ')}`);
    }
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

function isSlotEligibleForPrewarm(slot) {
  return String(slot?.LeaseState__c || '').trim() === 'available';
}

async function main(argv = process.argv.slice(2)) {
  const command = getCommand(argv);
  if (!command || hasFlag('help', argv)) {
    printHelp();
    return;
  }

  const targetOrg = resolveTargetOrg(argv);
  if (!targetOrg) {
    throw new Error('Missing target org. Pass --target-org or set SF_DEVHUB_ALIAS.');
  }

  const poolKey = getArgValue('pool-key', argv) || getArgValue('pool', argv);
  const asJson = hasFlag('json', argv);

  let result;
  if (command === 'bootstrap') {
    const config = normalizePoolConfig(argv);
    if (!config.poolKey) {
      throw new Error('Missing required --pool-key for bootstrap.');
    }
    result = await bootstrapPool(targetOrg, config);
  } else if (command === 'list') {
    if (!poolKey) {
      throw new Error('Missing required --pool-key for list.');
    }
    result = await listPool(targetOrg, poolKey);
  } else if (command === 'reconcile') {
    if (!poolKey) {
      throw new Error('Missing required --pool-key for reconcile.');
    }
    result = await reconcilePool(targetOrg, poolKey);
  } else if (command === 'prewarm') {
    if (!poolKey) {
      throw new Error('Missing required --pool-key for prewarm.');
    }
    result = await prewarmPool(targetOrg, poolKey, normalizePrewarmOptions(argv));
  } else if (command === 'disable-slot') {
    const slotKey = getArgValue('slot-key', argv);
    if (!poolKey || !slotKey) {
      throw new Error('Missing required --pool-key or --slot-key for disable-slot.');
    }
    result = await disableSlot(targetOrg, poolKey, slotKey, getArgValue('reason', argv));
  } else if (command === 'reset-slot') {
    const slotKey = getArgValue('slot-key', argv);
    if (!poolKey || !slotKey) {
      throw new Error('Missing required --pool-key or --slot-key for reset-slot.');
    }
    result = await resetSlot(targetOrg, poolKey, slotKey, getArgValue('reason', argv));
  } else {
    throw new Error(`Unknown command '${command}'.`);
  }

  renderResult(result, asJson);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  bootstrapPool,
  buildSlotDescriptors,
  buildPoolScratchDefinition,
  deleteExistingScratchForSlot,
  execFileAsync,
  isSlotEligibleForPrewarm,
  normalizePoolConfig,
  normalizePrewarmOptions,
  toRestRecordPayload,
  toScratchExpirationDateTimeValue,
  toSfValuesArgument
};
