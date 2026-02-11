import assert from 'assert/strict';
const proxyquire: any = require('proxyquire').noCallThru().noPreserveCache();

type CacheSetCall = { section: string; key: string; value: unknown; ttl: number };

function loadCliWithStubs(params: {
  persistedOrgList: unknown;
  execCommand: (program: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}) {
  const setCalls: CacheSetCall[] = [];
  const CacheManager = {
    get: (_section: string, key: string) => (key === 'orgList' ? params.persistedOrgList : undefined),
    set: async (section: string, key: string, value: unknown, ttl: number) => {
      setCalls.push({ section, key, value, ttl });
    },
    delete: async () => {}
  };

  const execModule = {
    execCommand: (program: string, args: string[]) => params.execCommand(program, args),
    CLI_TIMEOUT_MS: 120000,
    execOverriddenForTests: false,
    execOverrideGeneration: 0,
    markExecOverriddenForTests: () => {}
  };

  const cli = proxyquire('../salesforce/cli', {
    '../utils/cacheManager': { CacheManager, '@noCallThru': true },
    '../utils/config': {
      getBooleanConfig: () => true,
      getNumberConfig: (_key: string, def: number) => def,
      '@noCallThru': true
    },
    './exec': { ...execModule, '@noCallThru': true },
    './path': { resolvePATHFromLoginShell: async () => undefined, '@noCallThru': true },
    '../shared/telemetry': { safeSendException: () => {}, '@noCallThru': true },
    '../utils/logger': { logTrace: () => {}, '@noCallThru': true },
    '../utils/localize': {
      localize: (_key: string, fallback: string) => fallback,
      '@noCallThru': true
    }
  });

  return { listOrgs: cli.listOrgs as (forceRefresh?: boolean) => Promise<any[]>, setCalls };
}

suite('listOrgs persistent cache fallback', () => {
  test('refreshes from CLI when persisted org list cache is empty', async () => {
    let execCalls = 0;
    const { listOrgs, setCalls } = loadCliWithStubs({
      persistedOrgList: [],
      execCommand: async () => {
        execCalls++;
        return {
          stdout: JSON.stringify({
            result: {
              nonScratchOrgs: [{ username: 'user@example.com', alias: 'user', isDefaultUsername: true }]
            }
          }),
          stderr: ''
        };
      }
    });

    const orgs = await listOrgs(false);
    assert.equal(execCalls, 1, 'expected CLI call instead of returning cached empty list');
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.username, 'user@example.com');
    assert.equal(setCalls.length, 1, 'expected refreshed list to be persisted');
  });

  test('does not persist empty cache when CLI returns errors', async () => {
    let execCalls = 0;
    const { listOrgs, setCalls } = loadCliWithStubs({
      persistedOrgList: [],
      execCommand: async () => {
        execCalls++;
        const err: any = new Error('boom');
        err.code = 1;
        throw err;
      }
    });

    await assert.rejects(listOrgs(false), /boom/);
    assert.equal(execCalls, 2, 'expected both sf and sfdx attempts');
    assert.equal(setCalls.length, 0, 'expected no poisoned empty cache writes on failure');
  });
});
