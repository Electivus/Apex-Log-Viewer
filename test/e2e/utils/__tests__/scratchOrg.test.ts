import { ensureScratchOrg } from '../scratchOrg';
import { runSfJson } from '../sfCli';

jest.mock('../sfCli', () => ({
  runSfJson: jest.fn()
}));

const runSfJsonMock = jest.mocked(runSfJson);

const FALLBACK_DEV_HUB_ALIASES = [
  'DevHubElectivus',
  'DevHub',
  'ElectivusDevHub',
  'InsuranceOrgTrialCreme6DevHub'
];

describe('ensureScratchOrg', () => {
  const originalEnv = { ...process.env };
  let consoleInfoSpy: jest.SpiedFunction<typeof console.info>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SF_DEVHUB_ALIAS: 'ConfiguredDevHub',
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };
    runSfJsonMock.mockReset();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
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
      created: true
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
      created: false
    });
    expect(runSfJsonMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch']),
      expect.anything()
    );
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
});
