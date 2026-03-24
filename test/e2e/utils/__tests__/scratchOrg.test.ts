import { ensureScratchOrg } from '../scratchOrg';
import { runSfJson } from '../sfCli';
import { assertToolingReady, getOrgAuth, primeOrgAuthCache } from '../tooling';

jest.mock('../sfCli', () => ({
  runSfJson: jest.fn()
}));

jest.mock('../tooling', () => ({
  getOrgAuth: jest.fn(),
  assertToolingReady: jest.fn(),
  primeOrgAuthCache: jest.fn()
}));

const runSfJsonMock = jest.mocked(runSfJson);
const getOrgAuthMock = jest.mocked(getOrgAuth);
const assertToolingReadyMock = jest.mocked(assertToolingReady);
const primeOrgAuthCacheMock = jest.mocked(primeOrgAuthCache);

const FALLBACK_DEV_HUB_ALIASES = [
  'DevHubElectivus',
  'DevHub',
  'ElectivusDevHub',
  'InsuranceOrgTrialCreme6DevHub'
];

function createJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe('ensureScratchOrg', () => {
  const originalEnv = { ...process.env };
  let consoleInfoSpy: jest.SpiedFunction<typeof console.info>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SF_DEVHUB_ALIAS: 'ConfiguredDevHub',
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };
    delete process.env.SF_DEVHUB_AUTH_URL;
    delete process.env.SF_SCRATCH_STRATEGY;
    delete process.env.SF_SCRATCH_POOL_NAME;

    runSfJsonMock.mockReset();
    getOrgAuthMock.mockReset();
    assertToolingReadyMock.mockReset();
    primeOrgAuthCacheMock.mockReset();

    getOrgAuthMock.mockResolvedValue({
      accessToken: 'devhub-token',
      instanceUrl: 'https://devhub.example.com',
      username: 'devhub@example.com',
      apiVersion: '60.0'
    });
    assertToolingReadyMock.mockResolvedValue(undefined);

    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected fetch call.');
    });
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('fails before any scratch lookup when dev hub config is missing', async () => {
    process.env = {
      ...originalEnv,
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };

    delete process.env.SF_DEVHUB_ALIAS;
    delete process.env.SF_DEVHUB_AUTH_URL;

    await expect(ensureScratchOrg()).rejects.toThrow(
      'Missing required Dev Hub configuration. Set SF_DEVHUB_AUTH_URL or SF_DEVHUB_ALIAS.'
    );
    expect(runSfJsonMock).not.toHaveBeenCalled();
  });

  test('recreates a scratch org using only the explicitly configured dev hub alias', async () => {
    let scratchDisplayCount = 0;

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        scratchDisplayCount += 1;
        if (scratchDisplayCount === 1) {
          return {
            status: 0,
            result: {
              status: 'Deleted',
              expirationDate: '2026-03-07',
              alias: 'ALV_E2E_Scratch'
            }
          };
        }

        return {
          status: 0,
          result: {
            status: 'Active',
            expirationDate: '2099-03-07',
            alias: 'ALV_E2E_Scratch'
          }
        };
      }

      if (args[0] === 'org' && args[1] === 'logout' && args.includes('ALV_E2E_Scratch')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'alias' && args[1] === 'unset' && args.includes('ALV_E2E_Scratch')) {
        return { status: 0, result: {} };
      }

      if (
        args[0] === 'org' &&
        args[1] === 'create' &&
        args[2] === 'scratch' &&
        args.includes('ConfiguredDevHub')
      ) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'data' && args[1] === 'query') {
        return {
          status: 0,
          result: {
            records: [{ Id: '7dl000000000001AAA' }]
          }
        };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const scratch = await ensureScratchOrg();

    expect(scratch).toMatchObject({
      devHubAlias: 'ConfiguredDevHub',
      scratchAlias: 'ALV_E2E_Scratch',
      created: true,
      strategy: 'single'
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'logout', '--target-org', 'ALV_E2E_Scratch', '--no-prompt']);
    expect(runSfJsonMock).toHaveBeenCalledWith(['alias', 'unset', 'ALV_E2E_Scratch']);
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch', '--target-dev-hub', 'ConfiguredDevHub', '--alias', 'ALV_E2E_Scratch']),
      expect.any(Object)
    );

    const displayAliases = runSfJsonMock.mock.calls
      .filter(([args]) => args[0] === 'org' && args[1] === 'display' && args.includes('-o'))
      .map(([args]) => args[args.indexOf('-o') + 1]);
    for (const fallbackAlias of FALLBACK_DEV_HUB_ALIASES) {
      expect(displayAliases).not.toContain(fallbackAlias);
    }

    expect(consoleInfoSpy).toHaveBeenCalledWith("[e2e] scratch org created for alias 'ALV_E2E_Scratch'.");
    await scratch.cleanup();
  });

  test('reuses an active scratch org when the alias is still valid', async () => {
    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        return {
          status: 0,
          result: {
            status: 'Active',
            expirationDate: '2099-03-07',
            alias: 'ALV_E2E_Scratch'
          }
        };
      }

      if (args[0] === 'data' && args[1] === 'query') {
        return {
          status: 0,
          result: {
            records: [{ Id: '7dl000000000001AAA' }]
          }
        };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const scratch = await ensureScratchOrg();

    expect(scratch).toMatchObject({
      devHubAlias: 'ConfiguredDevHub',
      scratchAlias: 'ALV_E2E_Scratch',
      created: false,
      strategy: 'single'
    });
    expect(runSfJsonMock).not.toHaveBeenCalledWith(expect.arrayContaining(['org', 'create', 'scratch']), expect.anything());
    expect(consoleInfoSpy).toHaveBeenCalledWith("[e2e] scratch org reused for alias 'ALV_E2E_Scratch'.");
    await scratch.cleanup();
  });

  test('fails immediately when the configured dev hub alias is not authenticated', async () => {
    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ConfiguredDevHub')) {
        throw new Error('NamedOrgNotFoundError: No authorization information found for ConfiguredDevHub.');
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    await expect(ensureScratchOrg()).rejects.toThrow(
      "Dev Hub alias 'ConfiguredDevHub' is not authenticated or unavailable."
    );

    expect(runSfJsonMock).toHaveBeenCalledTimes(1);
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'display', '-o', 'ConfiguredDevHub']);
  });

  test('fails immediately when SF_DEVHUB_AUTH_URL authentication fails', async () => {
    process.env = {
      ...originalEnv,
      SF_DEVHUB_ALIAS: 'ConfiguredDevHub',
      SF_DEVHUB_AUTH_URL: 'force://redacted',
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url') {
        throw new Error('INVALID_AUTH_URL: failed to authenticate Dev Hub');
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    await expect(ensureScratchOrg()).rejects.toThrow('INVALID_AUTH_URL: failed to authenticate Dev Hub');

    expect(runSfJsonMock).toHaveBeenCalledTimes(1);
    expect(runSfJsonMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        'org',
        'login',
        'sfdx-url',
        '--sfdx-url-file',
        expect.any(String),
        '--set-default-dev-hub',
        '--alias',
        'ConfiguredDevHub'
      ])
    );
  });

  test('fails on scratch signup limit without trying another dev hub alias', async () => {
    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        throw new Error('NamedOrgNotFoundError: No authorization information found for ALV_E2E_Scratch.');
      }

      if (
        args[0] === 'org' &&
        args[1] === 'create' &&
        args[2] === 'scratch' &&
        args.includes('ConfiguredDevHub')
      ) {
        throw new Error(
          'LIMIT_EXCEEDED: The signup request failed because this organization has reached its daily scratch org signup limit'
        );
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    await expect(ensureScratchOrg()).rejects.toThrow(
      "Failed to create scratch org 'ALV_E2E_Scratch': LIMIT_EXCEEDED: The signup request failed because this organization has reached its daily scratch org signup limit"
    );

    const createScratchCalls = runSfJsonMock.mock.calls.filter(
      ([args]) => args[0] === 'org' && args[1] === 'create' && args[2] === 'scratch'
    );
    expect(createScratchCalls).toHaveLength(1);
    expect(createScratchCalls[0]?.[0]).toEqual(
      expect.arrayContaining(['org', 'create', 'scratch', '--target-dev-hub', 'ConfiguredDevHub'])
    );

    const allArgs = runSfJsonMock.mock.calls.flatMap(([args]) => args);
    for (const fallbackAlias of FALLBACK_DEV_HUB_ALIASES) {
      expect(allArgs).not.toContain(fallbackAlias);
    }
  });

  test('reuses a pooled scratch org via sfdx auth URL and releases the lease on cleanup', async () => {
    process.env.SF_SCRATCH_STRATEGY = 'pool';
    process.env.SF_SCRATCH_POOL_NAME = 'alv-e2e';
    process.env.SF_DEVHUB_AUTH_URL = 'force://devhub-auth';

    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')) {
        return createJsonResponse({
          ok: true,
          poolKey: 'alv-e2e',
          slotKey: 'slot-01',
          scratchAlias: 'ALV_E2E_POOL_01',
          leaseToken: 'lease-123',
          needsCreate: false,
          scratchUsername: 'slot01@example.com',
          scratchLoginUrl: 'https://slot01.scratch.my.salesforce.com',
          scratchAuthUrl: 'force://slot01-auth',
          scratchDurationDays: 30
        });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/finalize')) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/release')) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ALV_E2E_POOL_01')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_POOL_01')) {
        return {
          status: 0,
          result: {
            status: 'Active',
            expirationDate: '2099-03-07',
            accessToken: 'scratch-token',
            instanceUrl: 'https://slot01.scratch.my.salesforce.com',
            username: 'slot01@example.com',
            sfdxAuthUrl: 'force://slot01-auth-updated'
          }
        };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const scratch = await ensureScratchOrg();

    expect(scratch).toMatchObject({
      devHubAlias: 'ConfiguredDevHub',
      scratchAlias: 'ALV_E2E_POOL_01',
      created: false,
      strategy: 'pool',
      slotKey: 'slot-01',
      leaseToken: 'lease-123'
    });
    expect(primeOrgAuthCacheMock).toHaveBeenCalledWith('ALV_E2E_POOL_01', {
      accessToken: 'scratch-token',
      instanceUrl: 'https://slot01.scratch.my.salesforce.com',
      username: 'slot01@example.com',
      apiVersion: '60.0'
    });
    expect(assertToolingReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'scratch-token',
        instanceUrl: 'https://slot01.scratch.my.salesforce.com'
      }),
      { timeoutMs: 30000 }
    );

    await scratch.cleanup();

    const releaseCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith('/services/apexrest/alv/scratch-pool/v1/release')
    );
    expect(releaseCall).toBeDefined();
    const releaseBody = JSON.parse(String(releaseCall?.[1]?.body || '{}'));
    expect(releaseBody.scratchAuthUrl).toBe('force://slot01-auth-updated');
  });

  test('creates a pooled scratch org when the acquired slot requires recreation', async () => {
    process.env.SF_SCRATCH_STRATEGY = 'pool';
    process.env.SF_SCRATCH_POOL_NAME = 'alv-e2e';
    process.env.SF_DEVHUB_AUTH_URL = 'force://devhub-auth';

    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')) {
        return createJsonResponse({
          ok: true,
          poolKey: 'alv-e2e',
          slotKey: 'slot-02',
          scratchAlias: 'ALV_E2E_POOL_02',
          leaseToken: 'lease-create',
          needsCreate: true,
          scratchDurationDays: 30
        });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/finalize')) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/release')) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'logout' && args.includes('ALV_E2E_POOL_02')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'alias' && args[1] === 'unset' && args.includes('ALV_E2E_POOL_02')) {
        return { status: 0, result: {} };
      }

      if (
        args[0] === 'org' &&
        args[1] === 'create' &&
        args[2] === 'scratch' &&
        args.includes('--target-dev-hub') &&
        args.includes('ConfiguredDevHub') &&
        args.includes('ALV_E2E_POOL_02')
      ) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_POOL_02')) {
        return {
          status: 0,
          result: {
            status: 'Active',
            expirationDate: '2099-03-07',
            accessToken: 'scratch-token',
            instanceUrl: 'https://slot02.scratch.my.salesforce.com',
            username: 'slot02@example.com',
            sfdxAuthUrl: 'force://slot02-auth'
          }
        };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const scratch = await ensureScratchOrg();

    expect(scratch).toMatchObject({
      scratchAlias: 'ALV_E2E_POOL_02',
      created: true,
      strategy: 'pool',
      slotKey: 'slot-02',
      leaseToken: 'lease-create'
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'logout', '--target-org', 'ALV_E2E_POOL_02', '--no-prompt']);
    expect(runSfJsonMock).toHaveBeenCalledWith(['alias', 'unset', 'ALV_E2E_POOL_02']);
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        'org',
        'create',
        'scratch',
        '--target-dev-hub',
        'ConfiguredDevHub',
        '--alias',
        'ALV_E2E_POOL_02'
      ]),
      expect.any(Object)
    );

    const acquireCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')
    );
    expect(acquireCall).toBeDefined();
    const acquireBody = JSON.parse(String(acquireCall?.[1]?.body || '{}'));
    expect(acquireBody.poolKey).toBe('alv-e2e');
    expect(acquireBody.seedVersion).toBe('alv-e2e-baseline-v1');

    const finalizeCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith('/services/apexrest/alv/scratch-pool/v1/finalize')
    );
    expect(finalizeCall).toBeDefined();
    const finalizeBody = JSON.parse(String(finalizeCall?.[1]?.body || '{}'));
    expect(finalizeBody.created).toBe(true);
    expect(finalizeBody.scratchAuthUrl).toBe('force://slot02-auth');

    await scratch.cleanup();
  });

  test('recreates a pooled scratch org when the stored scratch auth URL is stale', async () => {
    process.env.SF_SCRATCH_STRATEGY = 'pool';
    process.env.SF_SCRATCH_POOL_NAME = 'alv-e2e';
    process.env.SF_DEVHUB_AUTH_URL = 'force://devhub-auth';

    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')) {
        return createJsonResponse({
          ok: true,
          poolKey: 'alv-e2e',
          slotKey: 'slot-03',
          scratchAlias: 'ALV_E2E_POOL_03',
          leaseToken: 'lease-stale',
          needsCreate: false,
          scratchUsername: 'slot03@example.com',
          scratchLoginUrl: 'https://slot03.scratch.my.salesforce.com',
          scratchAuthUrl: 'force://slot03-stale-auth',
          scratchOrgInfoId: '2SR000000000001AAA',
          activeScratchOrgId: '0SO000000000001AAA',
          scratchDurationDays: 30
        });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/finalize')) {
        return createJsonResponse({ ok: true });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/release')) {
        return createJsonResponse({ ok: true });
      }
      if (url.includes('/services/data/v60.0/sobjects/ActiveScratchOrg/0SO000000000001AAA')) {
        return {
          ok: true,
          status: 204,
          text: async () => ''
        } as Response;
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ALV_E2E_POOL_03')) {
        throw new Error('INVALID_SFDX_AUTH_URL: expired refresh token');
      }

      if (args[0] === 'org' && args[1] === 'logout' && args.includes('ALV_E2E_POOL_03')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'alias' && args[1] === 'unset' && args.includes('ALV_E2E_POOL_03')) {
        return { status: 0, result: {} };
      }

      if (
        args[0] === 'org' &&
        args[1] === 'create' &&
        args[2] === 'scratch' &&
        args.includes('--target-dev-hub') &&
        args.includes('ConfiguredDevHub') &&
        args.includes('ALV_E2E_POOL_03')
      ) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_POOL_03')) {
        return {
          status: 0,
          result: {
            status: 'Active',
            expirationDate: '2099-03-07',
            accessToken: 'scratch-token',
            instanceUrl: 'https://slot03.scratch.my.salesforce.com',
            username: 'slot03@example.com',
            sfdxAuthUrl: 'force://slot03-fresh-auth'
          }
        };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const scratch = await ensureScratchOrg();

    expect(scratch).toMatchObject({
      scratchAlias: 'ALV_E2E_POOL_03',
      created: true,
      strategy: 'pool',
      slotKey: 'slot-03',
      leaseToken: 'lease-stale'
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'logout', '--target-org', 'ALV_E2E_POOL_03', '--no-prompt']);
    expect(runSfJsonMock).toHaveBeenCalledWith(['alias', 'unset', 'ALV_E2E_POOL_03']);

    const finalizeCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith('/services/apexrest/alv/scratch-pool/v1/finalize')
    );
    expect(finalizeCall).toBeDefined();
    const finalizeBody = JSON.parse(String(finalizeCall?.[1]?.body || '{}'));
    expect(finalizeBody.created).toBe(true);
    expect(finalizeBody.scratchAuthUrl).toBe('force://slot03-fresh-auth');

    await scratch.cleanup();
  });

  test('releases the pool lease when the acquire response is missing scratchAlias', async () => {
    process.env.SF_SCRATCH_STRATEGY = 'pool';
    process.env.SF_SCRATCH_POOL_NAME = 'alv-e2e';
    process.env.SF_DEVHUB_AUTH_URL = 'force://devhub-auth';

    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')) {
        return createJsonResponse({
          ok: true,
          poolKey: 'alv-e2e',
          slotKey: 'slot-04',
          leaseToken: 'lease-incomplete',
          needsCreate: false
        });
      }
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/release')) {
        return createJsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    await expect(ensureScratchOrg()).rejects.toThrow(
      'Scratch-org pool acquire response was missing scratchAlias.'
    );

    const releaseCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).endsWith('/services/apexrest/alv/scratch-pool/v1/release')
    );
    expect(releaseCall).toBeDefined();
    const releaseBody = JSON.parse(String(releaseCall?.[1]?.body || '{}'));
    expect(releaseBody.slotKey).toBe('slot-04');
    expect(releaseBody.leaseToken).toBe('lease-incomplete');
    expect(releaseBody.success).toBe(false);
    expect(releaseBody.needsRecreate).toBe(true);
  });

  test('redacts sensitive pool REST response bodies from thrown errors', async () => {
    process.env.SF_SCRATCH_STRATEGY = 'pool';
    process.env.SF_SCRATCH_POOL_NAME = 'alv-e2e';
    process.env.SF_DEVHUB_AUTH_URL = 'force://devhub-auth';

    fetchSpy.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/services/apexrest/alv/scratch-pool/v1/acquire')) {
        return createJsonResponse(
          {
            message: 'Pool REST failure',
            scratchAuthUrl: 'force://secret-slot-auth'
          },
          500
        );
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'login' && args[2] === 'sfdx-url' && args.includes('ConfiguredDevHub')) {
        return { status: 0, result: {} };
      }

      throw new Error(`Unexpected sf command: ${args.join(' ')}`);
    });

    const error = await ensureScratchOrg().catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Pool REST failure');
    expect(error.message).not.toContain('force://secret-slot-auth');
  });
});
