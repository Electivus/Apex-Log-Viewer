import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureScratchOrg } from '../scratchOrg';
import { runSfJson } from '../sfCli';
import { __resetToolingCachesForTests, __setToolingConnectionFactoryForTests } from '../tooling';

jest.mock('../sfCli', () => ({ runSfJson: jest.fn() }));
const cli = jest.mocked(runSfJson);

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

describe('JWT pool consumer through CLI and REST adapters', () => {
  const originalEnv = process.env;
  const homeField = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const authUrl = 'force://PlatformCLI::fixture-refresh@scratch.example.com';
  let keyFile: string;
  let imported: boolean;
  let tokenReads: string[];
  let tick: (() => void) | undefined;
  let requests: Array<{ operation: string; body: any }>;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CI: 'true',
      SF_DEVHUB_CLIENT_ID: 'fixture-eca',
      SF_DEVHUB_USERNAME: 'operator@example.com',
      SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
      SF_DEVHUB_PRIVATE_KEY: generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
      }).privateKey,
      SF_SCRATCH_STRATEGY: 'pool',
      SF_SCRATCH_POOL_NAME: 'isolated',
      SF_SCRATCH_POOL_HEARTBEAT_SECONDS: '15'
    };
    delete process.env.SF_DEVHUB_PRIVATE_KEY_FILE;
    keyFile = '';
    imported = false;
    tokenReads = [];
    requests = [];
    tick = undefined;
    __resetToolingCachesForTests();
    __setToolingConnectionFactoryForTests(
      () =>
        ({
          request: jest.fn(),
          tooling: { query: async () => ({ records: [{ Id: 'debug-level' }] }) }
        }) as any
    );
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(globalThis, 'setInterval').mockImplementation(handler => {
      tick = handler as () => void;
      return { unref: () => {} } as NodeJS.Timeout;
    });
    jest.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    cli.mockReset();
    cli.mockImplementation(async (args, options) => {
      const command = args.slice(0, 3).join(' ');
      const target = args[args.indexOf('--target-org') + 1];
      if (command === 'org login jwt') {
        keyFile = args[args.indexOf('--jwt-key-file') + 1]!;
        expect(existsSync(keyFile)).toBe(true);
        return { status: 0, result: { username: 'operator@example.com' } };
      }
      if (command === 'org login sfdx-url') {
        expect(readFileSync(args[args.indexOf('--sfdx-url-file') + 1]!, 'utf8') === authUrl).toBe(true);
        imported = true;
        return { status: 0, result: { username: 'scratch@example.com' } };
      }
      if (target === 'operator@example.com') {
        expect(existsSync(keyFile)).toBe(true);
        expect(options?.env?.[homeField]).toBe(path.dirname(keyFile));
      }
      if (args[1] === 'display')
        return {
          status: 0,
          result: {
            username: target === 'operator@example.com' ? target : 'scratch@example.com',
            instanceUrl:
              target === 'operator@example.com' ? 'https://devhub.example.com' : 'https://scratch.example.com',
            accessToken: 'fixture-access-token',
            status: 'Active'
          }
        };
      if (command === 'org auth show-access-token') {
        if (target === 'operator@example.com') tokenReads.push(options!.env![homeField]!);
        return { status: 0, result: { accessToken: `fixture-access-token-${tokenReads.length}` } };
      }
      if (command === 'org auth show-sfdx-auth-url') return { status: 0, result: { sfdxAuthUrl: authUrl } };
      throw new Error('Unexpected CLI operation');
    });
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      expect(existsSync(keyFile)).toBe(true);
      const url = String(input);
      const operation = url.split('/').pop()!;
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ operation, body });
      if (url.includes('/query/')) return response({ records: [{ SeedVersion__c: 'seed-v1' }] });
      if (operation === 'acquire')
        return response({
          ok: true,
          poolKey: 'isolated',
          slotKey: 'slot-01',
          scratchAlias: 'ISOLATED_01',
          leaseToken: 'fixture-lease',
          needsCreate: false,
          scratchAuthUrl: authUrl
        });
      return response({ ok: true });
    });
  });

  afterEach(() => {
    if (keyFile && existsSync(keyFile)) {
      const directory = path.resolve(path.dirname(keyFile));
      expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
      expect(path.basename(directory).startsWith('alv-devhub-jwt-')).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    process.env = originalEnv;
    __resetToolingCachesForTests();
    jest.restoreAllMocks();
  });

  test.each(['acquire', 'finalize', 'heartbeat', 'release'])(
    'renews JWT from the originating home when %s rejects an expired token',
    async operation => {
      const request = fetchSpy.getMockImplementation()!;
      let expired = false;
      fetchSpy.mockImplementation(async (input, options) => {
        if (String(input).endsWith(`/${operation}`) && !expired) {
          expired = true;
          return response([{ errorCode: 'INVALID_SESSION_ID', message: 'private token' }], 401);
        }
        return request(input, options);
      });
      const scratch = await ensureScratchOrg();
      try {
        expect(scratch.created).toBe(false);
        expect(imported).toBe(true);
        tick?.();
        await new Promise(resolve => setImmediate(resolve));
      } finally {
        await scratch.cleanup();
      }
      expect(requests.some(item => item.operation === 'heartbeat')).toBe(true);
      expect(tokenReads).toEqual([path.dirname(keyFile), path.dirname(keyFile)]);
      expect(requests.find(item => item.operation === 'release')?.body).toMatchObject({
        success: true,
        needsRecreate: false,
        leaseToken: 'fixture-lease',
        scratchAuthUrl: authUrl
      });
      expect(existsSync(keyFile)).toBe(false);
    }
  );

  test('cleanup drains an in-flight heartbeat renewal before releasing the lease and deleting JWT state', async () => {
    const request = fetchSpy.getMockImplementation()!;
    let unblock!: () => void;
    const pendingHeartbeat = new Promise<void>(resolve => {
      unblock = resolve;
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    let rejectedOnce = false;
    fetchSpy.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/heartbeat') && !rejectedOnce) {
        rejectedOnce = true;
        notifyStarted();
        await pendingHeartbeat;
        return response([{ errorCode: 'INVALID_SESSION_ID' }], 401);
      }
      return request(input, options);
    });
    const scratch = await ensureScratchOrg();
    tick?.();
    await started;
    const cleanup = scratch.cleanup();
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(existsSync(keyFile)).toBe(true);
      expect(requests.some(item => item.operation === 'release')).toBe(false);
    } finally {
      unblock();
      await cleanup;
    }
    expect(tokenReads).toEqual([path.dirname(keyFile), path.dirname(keyFile)]);
    expect(requests.some(item => item.operation === 'release')).toBe(true);
    expect(existsSync(keyFile)).toBe(false);
  });

  test('ownership failure releases the lease without deleting caller auth or creating another scratch', async () => {
    const request = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/acquire'))
        return response({
          ok: true,
          poolKey: 'isolated',
          slotKey: 'slot-01',
          scratchAlias: 'ISOLATED_01',
          leaseToken: 'fixture-lease',
          needsCreate: true,
          activeScratchOrgId: 'previous-active',
          scratchOrgInfoId: 'previous-info',
          scratchAuthUrl: authUrl
        });
      if (options?.method === 'DELETE')
        return response(
          [
            {
              errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
              message: 'consumer-secret private-token'
            }
          ],
          403
        );
      return request(input, options);
    });
    await expect(ensureScratchOrg()).rejects.toThrow(/existing owner|administrator/);
    expect(cli.mock.calls.some(([args]) => ['logout', 'create'].includes(args[1]!))).toBe(false);
    const released = requests.find(item => item.operation === 'release')?.body;
    expect(released).toMatchObject({ success: false, needsRecreate: false, scratchAuthUrl: authUrl });
    expect(JSON.stringify(released)).not.toMatch(/consumer-secret|private-token/);
    expect(existsSync(keyFile)).toBe(false);
  });

  test('malformed scratch export cannot be finalized or released as a usable pool credential', async () => {
    const invoke = cli.getMockImplementation()!;
    cli.mockImplementation(async (args, options) =>
      args.includes('show-sfdx-auth-url')
        ? { status: 0, result: { sfdxAuthUrl: 'force://not-an-authorization-url' } }
        : invoke(args, options)
    );
    const scratch = await ensureScratchOrg();
    await scratch.cleanup();
    expect(requests.find(item => item.operation === 'finalize')?.body.scratchAuthUrl).toBe(authUrl);
    expect(requests.find(item => item.operation === 'release')?.body).toMatchObject({ needsRecreate: true });
    expect(JSON.stringify(requests)).not.toContain('not-an-authorization-url');
  });
});
