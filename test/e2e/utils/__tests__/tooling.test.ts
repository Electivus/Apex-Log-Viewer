const runSfJsonMock = jest.fn();
const queryToolingMock = jest.fn();
const connectionRequestMock = jest.fn();

jest.mock('../sfCli', () => ({
  runSfJson: (...args: unknown[]) => runSfJsonMock(...args)
}));

import {
  __resetToolingCachesForTests,
  __setToolingConnectionFactoryForTests,
  ensureE2eTraceFlag,
  ensureDebugFlagsTestUser,
  executeAnonymousApex,
  findRecentApexLogId,
  getDebugLevelByDeveloperName,
  getCurrentUserId,
  getOrgAuth,
  resolveSpecialTraceFlagTarget,
  type OrgAuth
} from '../tooling';

type MockFetchResponse = {
  status: number;
  body?: unknown;
};

function responseFrom(spec: MockFetchResponse): Response {
  const text = spec.body === undefined ? '' : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    text: async () => text
  } as unknown as Response;
}

describe('ensureDebugFlagsTestUser', () => {
  const originalFetch = globalThis.fetch;
  const originalUsernameEnv = process.env.SF_E2E_DEBUG_FLAGS_USERNAME;
  const originalTargetOrgAlias = process.env.SF_E2E_TARGET_ORG_ALIAS;
  const originalAccessToken = process.env.SF_E2E_ACCESS_TOKEN;
  const originalInstanceUrl = process.env.SF_E2E_INSTANCE_URL;
  const originalApiVersion = process.env.SF_E2E_API_VERSION;
  const originalUsername = process.env.SF_E2E_USERNAME;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as Partial<typeof globalThis>).fetch;
    }
    if (originalUsernameEnv === undefined) {
      delete process.env.SF_E2E_DEBUG_FLAGS_USERNAME;
    } else {
      process.env.SF_E2E_DEBUG_FLAGS_USERNAME = originalUsernameEnv;
    }
    if (originalTargetOrgAlias === undefined) {
      delete process.env.SF_E2E_TARGET_ORG_ALIAS;
    } else {
      process.env.SF_E2E_TARGET_ORG_ALIAS = originalTargetOrgAlias;
    }
    if (originalAccessToken === undefined) {
      delete process.env.SF_E2E_ACCESS_TOKEN;
    } else {
      process.env.SF_E2E_ACCESS_TOKEN = originalAccessToken;
    }
    if (originalInstanceUrl === undefined) {
      delete process.env.SF_E2E_INSTANCE_URL;
    } else {
      process.env.SF_E2E_INSTANCE_URL = originalInstanceUrl;
    }
    if (originalApiVersion === undefined) {
      delete process.env.SF_E2E_API_VERSION;
    } else {
      process.env.SF_E2E_API_VERSION = originalApiVersion;
    }
    if (originalUsername === undefined) {
      delete process.env.SF_E2E_USERNAME;
    } else {
      process.env.SF_E2E_USERNAME = originalUsername;
    }
    runSfJsonMock.mockReset();
    queryToolingMock.mockReset();
    connectionRequestMock.mockReset();
    __resetToolingCachesForTests();
  });

  test('falls back to authenticated user when reactivating inactive user hits LICENSE_LIMIT_EXCEEDED', async () => {
    process.env.SF_E2E_DEBUG_FLAGS_USERNAME = 'alv.debugflags.target@example.com';
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();

      if (method === 'GET' && url.includes('/query?q=')) {
        const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));
        if (soql.includes("Username = 'alv.debugflags.target@example.com'")) {
          return responseFrom({
            status: 200,
            body: {
              records: [{ Id: '005000000000001AAA', Username: 'alv.debugflags.target@example.com', IsActive: false }]
            }
          });
        }
        if (soql.includes("Username = 'auth.user@example.com'")) {
          return responseFrom({
            status: 200,
            body: {
              records: [{ Id: '005000000000999AAA' }]
            }
          });
        }
      }

      if (method === 'PATCH' && url.endsWith('/sobjects/User/005000000000001AAA')) {
        return responseFrom({
          status: 400,
          body: [
            {
              message: 'LICENSE_LIMIT_EXCEEDED: no licenses available',
              errorCode: 'LICENSE_LIMIT_EXCEEDED'
            }
          ]
        });
      }

      throw new Error(`Unexpected request ${method} ${url}`);
    });

    const user = await ensureDebugFlagsTestUser(auth);
    expect(user).toEqual({
      id: '005000000000999AAA',
      username: 'auth.user@example.com'
    });
  });

  test('queries DebugLevel records with a compatible tooling API version', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '60.0'
    };
    const calls: string[] = [];

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return responseFrom({
        status: 200,
        body: {
          records: [
            {
              Id: '7dl000000000001AAA',
              DeveloperName: 'ALV_POST_64',
              MasterLabel: 'ALV POST 64',
              Language: 'en_US',
              Workflow: 'INFO',
              Validation: 'WARN',
              Callout: 'DEBUG',
              ApexCode: 'DEBUG',
              ApexProfiling: 'INFO',
              Visualforce: 'WARN',
              System: 'DEBUG',
              Database: 'INFO',
              Wave: 'DEBUG',
              Nba: 'ERROR',
              DataAccess: 'WARN'
            }
          ]
        }
      });
    });

    const record = await getDebugLevelByDeveloperName(auth, 'ALV_POST_64');

    expect(record?.id).toBe('7dl000000000001AAA');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/services/data/v63.0/tooling/query');
  });

  test('caches org auth lookups per target org', async () => {
    runSfJsonMock.mockResolvedValue({
      result: {
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        username: 'auth.user@example.com'
      }
    });

    const first = await getOrgAuth('ALV_E2E_Scratch');
    const second = await getOrgAuth('ALV_E2E_Scratch');

    expect(first).toEqual(second);
    expect(runSfJsonMock).toHaveBeenCalledTimes(1);
    expect(runSfJsonMock).toHaveBeenCalledWith(['org', 'display', '-o', 'ALV_E2E_Scratch']);
  });

  test('caches current user id lookups per authenticated user', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };
    let calls = 0;

    globalThis.fetch = jest.fn(async () => {
      calls += 1;
      return responseFrom({
        status: 200,
        body: {
          records: [{ Id: '005000000000999AAA' }]
        }
      });
    });

    const first = await getCurrentUserId(auth);
    const second = await getCurrentUserId(auth);

    expect(first).toBe('005000000000999AAA');
    expect(second).toBe('005000000000999AAA');
    expect(calls).toBe(1);
  });

  test('skips repeated trace flag provisioning within the fast-path window', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };
    let calls = 0;

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));

      if (method === 'GET' && soql.includes("FROM User WHERE Username = 'auth.user@example.com'")) {
        return responseFrom({
          status: 200,
          body: { records: [{ Id: '005000000000999AAA' }] }
        });
      }

      if (method === 'GET' && soql.includes("FROM DebugLevel WHERE DeveloperName = 'ALV_E2E'")) {
        return responseFrom({
          status: 200,
          body: { records: [{ Id: '7dl000000000001AAA' }] }
        });
      }

      if (method === 'GET' && soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000999AAA'")) {
        return responseFrom({
          status: 200,
          body: { records: [{ Id: '7tf000000000001AAA' }] }
        });
      }

      if (method === 'PATCH' && url.endsWith('/tooling/sobjects/TraceFlag/7tf000000000001AAA')) {
        return responseFrom({ status: 204 });
      }

      throw new Error(`Unexpected request ${method} ${url}`);
    });

    await ensureE2eTraceFlag(auth);
    await ensureE2eTraceFlag(auth);

    expect(calls).toBe(4);
  });

  test('executes anonymous Apex via the jsforce-backed request helper', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };
    __setToolingConnectionFactoryForTests(async () => ({
      request: connectionRequestMock.mockResolvedValue({
        compiled: true,
        success: true
      }),
      tooling: {
        query: queryToolingMock
      }
    }));

    await executeAnonymousApex(auth, "System.debug('ALV');");

    expect(connectionRequestMock).toHaveBeenCalledTimes(1);
    expect(connectionRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET'
    });
    expect(String(connectionRequestMock.mock.calls[0]?.[0]?.url || '')).toContain('/tooling/executeAnonymous?');
  });

  test('finds the recent ApexLog by matching the seeded marker in the body', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async () =>
      responseFrom({
        status: 200,
        body: { records: [{ Id: '005000000000999AAA' }] }
      })
    );
    __setToolingConnectionFactoryForTests(async () => ({
      request: connectionRequestMock.mockImplementation(async (request: { url?: string }) => {
        if (String(request?.url || '').includes('/07L000000000002AAA/Body')) {
          return 'other log body';
        }
        if (String(request?.url || '').includes('/07L000000000001AAA/Body')) {
          return '... ALV_E2E_MARKER_123 ...';
        }
        return '';
      }),
      tooling: {
        query: queryToolingMock.mockResolvedValue({
          records: [
            { Id: '07L000000000002AAA', StartTime: '2026-03-14T20:23:54.000+0000' },
            { Id: '07L000000000001AAA', StartTime: '2026-03-14T20:23:54.000+0000' }
          ]
        })
      }
    }));

    const id = await findRecentApexLogId(auth, Date.parse('2026-03-14T20:23:54.381Z'), 'ALV_E2E_MARKER_123');

    expect(id).toBe('07L000000000001AAA');
    expect(queryToolingMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM ApexLog WHERE LogUserId = '005000000000999AAA'")
    );
  });

  test('resolves Platform Integration via accepted names and returns all active matches', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));

      if (
        soql.includes("Name IN ('Platform Integration', 'Platform Integration User')") &&
        soql.includes("UserType = 'CloudIntegrationUser'")
      ) {
        return responseFrom({
          status: 200,
          body: { records: [{ Id: '005000000000777AAA', Name: 'Platform Integration User' }] }
        });
      }

      throw new Error(`Unexpected request GET ${url}`);
    });

    const resolved = await resolveSpecialTraceFlagTarget(auth, 'platformIntegration');

    expect(resolved).toEqual({
      ids: ['005000000000777AAA'],
      label: 'Platform Integration',
      matchedNames: ['Platform Integration User']
    });
  });

  test('falls back to the first candidate name when Salesforce omits the special target name', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));

      if (
        soql.includes("Name IN ('Platform Integration', 'Platform Integration User')") &&
        soql.includes("UserType = 'CloudIntegrationUser'")
      ) {
        return responseFrom({
          status: 200,
          body: { records: [{ Id: '005000000000777AAA' }] }
        });
      }

      throw new Error(`Unexpected request GET ${url}`);
    });

    const resolved = await resolveSpecialTraceFlagTarget(auth, 'platformIntegration');

    expect(resolved).toEqual({
      ids: ['005000000000777AAA'],
      label: 'Platform Integration',
      matchedNames: ['Platform Integration']
    });
  });

  test('returns all active matches when a special target query finds multiple users', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const soql = decodeURIComponent(url.slice(url.indexOf('?q=') + 3));
      if (
        soql.includes("Name IN ('Platform Integration', 'Platform Integration User')") &&
        soql.includes("UserType = 'CloudIntegrationUser'")
      ) {
        return responseFrom({
          status: 200,
          body: {
            records: [
              { Id: '005000000000111AAA', Name: 'Platform Integration' },
              { Id: '005000000000222AAA', Name: 'Platform Integration User' }
            ]
          }
        });
      }

      throw new Error(`Unexpected request GET ${url}`);
    });

    await expect(resolveSpecialTraceFlagTarget(auth, 'platformIntegration')).resolves.toEqual({
      ids: ['005000000000111AAA', '005000000000222AAA'],
      label: 'Platform Integration',
      matchedNames: ['Platform Integration', 'Platform Integration User']
    });
  });

  test('returns undefined when a special trace-flag target is not available', async () => {
    const auth: OrgAuth = {
      accessToken: 'token',
      instanceUrl: 'https://example.my.salesforce.com',
      username: 'auth.user@example.com',
      apiVersion: '62.0'
    };

    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      return responseFrom({
        status: 200,
        body: { records: [] }
      });
    });

    await expect(resolveSpecialTraceFlagTarget(auth, 'automatedProcess')).resolves.toBeUndefined();
  });
});
