import { ensureScratchOrg } from '../scratchOrg';
import { runSfJson } from '../sfCli';

jest.mock('../sfCli', () => ({
  runSfJson: jest.fn()
}));

const runSfJsonMock = jest.mocked(runSfJson);

describe('ensureScratchOrg', () => {
  const originalEnv = { ...process.env };
  let consoleInfoSpy: jest.SpiedFunction<typeof console.info>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SF_DEVHUB_ALIAS: 'VlocityIndustriesInsuranceDevHub',
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };
    runSfJsonMock.mockReset();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('recreates a scratch org when the local alias points to a deleted org', async () => {
    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        return {
          status: 0,
          result: {
            status: 'Deleted',
            expirationDate: '2026-03-07',
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

      if (args[0] === 'org' && args[1] === 'display' && args.includes('VlocityIndustriesInsuranceDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'create' && args[2] === 'scratch') {
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
      devHubAlias: 'VlocityIndustriesInsuranceDevHub',
      scratchAlias: 'ALV_E2E_Scratch',
      created: true
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'logout', '--target-org', 'ALV_E2E_Scratch', '--no-prompt']);
    expect(runSfJsonMock).toHaveBeenCalledWith(['alias', 'unset', 'ALV_E2E_Scratch']);
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch', '--alias', 'ALV_E2E_Scratch']),
      expect.any(Object)
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith("[e2e] scratch org created for alias 'ALV_E2E_Scratch'.");
    await scratch.cleanup();
  });

  test('reuses an active scratch org when the alias is still valid', async () => {
    runSfJsonMock.mockImplementation(async args => {
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
      devHubAlias: 'VlocityIndustriesInsuranceDevHub',
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

  test('prefers DevHubElectivus locally when multiple fallback dev hubs are authenticated', async () => {
    process.env = {
      ...originalEnv,
      SF_SCRATCH_ALIAS: 'ALV_E2E_Scratch',
      SF_TEST_KEEP_ORG: '1'
    };

    delete process.env.SF_DEVHUB_ALIAS;
    delete process.env.SF_DEVHUB_AUTH_URL;

    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        throw new Error('NamedOrgNotFoundError: No authorization information found for ALV_E2E_Scratch.');
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('DevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('ElectivusDevHub')) {
        throw new Error('NamedOrgNotFoundError: No authorization information found for ElectivusDevHub.');
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('DevHubElectivus')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'create' && args[2] === 'scratch' && args.includes('DevHubElectivus')) {
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
      devHubAlias: 'DevHubElectivus',
      scratchAlias: 'ALV_E2E_Scratch',
      created: true
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch', '--target-dev-hub', 'DevHubElectivus']),
      expect.any(Object)
    );
    await scratch.cleanup();
  });

  test('falls back to another authenticated dev hub when the preferred alias hits the scratch signup limit', async () => {
    runSfJsonMock.mockImplementation(async args => {
      if (args[0] === 'org' && args[1] === 'display' && args.includes('ALV_E2E_Scratch')) {
        throw new Error('NamedOrgNotFoundError: No authorization information found for ALV_E2E_Scratch.');
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('VlocityIndustriesInsuranceDevHub')) {
        return { status: 0, result: {} };
      }

      if (args[0] === 'org' && args[1] === 'display' && args.includes('DevHub')) {
        return { status: 0, result: {} };
      }

      if (
        args[0] === 'org' &&
        args[1] === 'create' &&
        args[2] === 'scratch' &&
        args.includes('VlocityIndustriesInsuranceDevHub')
      ) {
        throw new Error('LIMIT_EXCEEDED: The signup request failed because this organization has reached its daily scratch org signup limit');
      }

      if (args[0] === 'org' && args[1] === 'create' && args[2] === 'scratch' && args.includes('DevHub')) {
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
      devHubAlias: 'DevHub',
      scratchAlias: 'ALV_E2E_Scratch',
      created: true
    });
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch', '--target-dev-hub', 'VlocityIndustriesInsuranceDevHub']),
      expect.any(Object)
    );
    expect(runSfJsonMock).toHaveBeenCalledWith(
      expect.arrayContaining(['org', 'create', 'scratch', '--target-dev-hub', 'DevHub']),
      expect.any(Object)
    );
    await scratch.cleanup();
  });
});
