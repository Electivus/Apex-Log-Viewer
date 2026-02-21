import { ensureDebugFlagsTestUser, type OrgAuth } from '../tooling';

type MockFetchResponse = {
  status: number;
  body?: unknown;
};

function responseFrom(spec: MockFetchResponse): Response {
  const text =
    spec.body === undefined ? '' : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    text: async () => text
  } as unknown as Response;
}

describe('ensureDebugFlagsTestUser', () => {
  const originalFetch = globalThis.fetch;
  const originalUsernameEnv = process.env.SF_E2E_DEBUG_FLAGS_USERNAME;

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
});
