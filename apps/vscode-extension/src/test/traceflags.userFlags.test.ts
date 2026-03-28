import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { workspace } from 'vscode';
import type { OrgAuth } from '../../../../src/salesforce/types';
import {
  __resetApiVersionFallbackStateForTests,
  getApiVersionFallbackWarning,
  getEffectiveApiVersion,
  __resetHttpsRequestImplForTests,
  __setHttpsRequestImplForTests,
  setApiVersion
} from '../../../../src/salesforce/http';
import {
  __resetDebugLevelApiVersionCacheForTests,
  __resetUserIdCacheForTests,
  createDebugLevel,
  deleteDebugLevel,
  getActiveUserDebugLevel,
  getTraceFlagTargetStatus,
  getUserTraceFlagStatus,
  listDebugLevels,
  listDebugLevelDetails,
  listActiveUsers,
  removeTraceFlags,
  removeUserTraceFlags,
  updateDebugLevel,
  upsertTraceFlag,
  upsertUserTraceFlag
} from '../../../../src/salesforce/traceflags';

type StubRequest = {
  method: string;
  path: string;
  body: string;
};

function installHttpsStub(responder: (req: StubRequest) => { statusCode: number; body?: unknown }): StubRequest[] {
  const calls: StubRequest[] = [];
  __setHttpsRequestImplForTests((options: any, cb: any) => {
    const req = new EventEmitter() as any;
    let body = '';
    req.on = function (event: string, listener: any) {
      EventEmitter.prototype.on.call(this, event, listener);
      return this;
    };
    req.setHeader = () => {};
    req.write = (chunk: any) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    };
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const snapshot: StubRequest = {
        method: String(options?.method || 'GET'),
        path: String(options?.path || ''),
        body
      };
      calls.push(snapshot);
      let output: { statusCode: number; body?: unknown };
      try {
        output = responder(snapshot);
      } catch (e) {
        process.nextTick(() => req.emit('error', e));
        return;
      }
      const res = new EventEmitter() as any;
      res.statusCode = output.statusCode;
      res.headers = {};
      res.on = function (event: string, listener: any) {
        EventEmitter.prototype.on.call(this, event, listener);
        return this;
      };
      res.setEncoding = () => {};
      res.req = req;
      cb(res);
      process.nextTick(() => {
        const text =
          output.body === undefined ? '' : typeof output.body === 'string' ? output.body : JSON.stringify(output.body);
        if (text) {
          res.emit('data', Buffer.from(text));
        }
        res.emit('end');
      });
    };
    return req;
  });
  return calls;
}

function decodeSoql(path: string): string {
  const qMarker = '?q=';
  const idx = path.indexOf(qMarker);
  if (idx < 0) {
    return '';
  }
  return decodeURIComponent(path.slice(idx + qMarker.length));
}

function isSpecialTargetUserResolutionQuery(soql: string, userType: string): boolean {
  return (
    soql.includes(`FROM User WHERE UserType = '${userType}'`) &&
    soql.includes('IsActive = true') &&
    !soql.includes('Name IN (')
  );
}

suite('traceflags user management', () => {
  const originalGetConfiguration = workspace.getConfiguration;
  const auth: OrgAuth = {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    username: 'user@example.com'
  };

  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetApiVersionFallbackStateForTests();
    __resetDebugLevelApiVersionCacheForTests();
    __resetUserIdCacheForTests();
    (workspace.getConfiguration as any) = originalGetConfiguration;
    setApiVersion('64.0');
  });

  test('listActiveUsers returns active users filtered by query', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'Ada Lovelace', Username: 'ada@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'Grace Hopper', Username: 'grace@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const users = await listActiveUsers(auth, 'ada', 25);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.id, '005000000000001AAA');
    assert.equal(users[0]?.username, 'ada@example.com');
    assert.equal(users[0]?.active, true);

    const soql = decodeSoql(calls[0]?.path || '');
    assert.match(soql, /FROM User/);
    assert.match(soql, /IsActive = true/);
    assert.match(soql, /Name LIKE '%ada%'/i);
    assert.doesNotMatch(soql, /\bESCAPE\b/i);
  });

  test('listActiveUsers applies local filtering when API returns broader result set', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'Ada Lovelace', Username: 'ada@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'Grace Hopper', Username: 'grace@example.com', IsActive: true },
              { Id: '005000000000003AAA', Name: 'Manoel Silva', Username: 'manoel@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const users = await listActiveUsers(auth, 'manoel', 50);
    assert.equal(users.length, 1);
    assert.equal(users[0]?.id, '005000000000003AAA');
    assert.equal(users[0]?.username, 'manoel@example.com');
  });

  test('listActiveUsers local filtering is locale-stable for dotted-i scenarios', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        return {
          statusCode: 200,
          body: {
            records: [
              { Id: '005000000000001AAA', Name: 'ILKER', Username: 'lk@example.com', IsActive: true },
              { Id: '005000000000002AAA', Name: 'GRACE', Username: 'grace@example.com', IsActive: true }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    (String.prototype as any).toLocaleLowerCase = function (locales?: string | string[]): string {
      if (locales !== undefined) {
        return originalToLocaleLowerCase.call(this, locales);
      }
      // Simulate a locale where 'I' lowercases to a non-ASCII dotted variant.
      return String(this).replace(/I/g, 'ı').toLowerCase();
    };

    try {
      const users = await listActiveUsers(auth, 'i', 50);
      assert.equal(users.length, 1);
      assert.equal(users[0]?.id, '005000000000001AAA');
      assert.equal(users[0]?.username, 'lk@example.com');
    } finally {
      (String.prototype as any).toLocaleLowerCase = originalToLocaleLowerCase;
    }
  });

  test('listActiveUsers falls back to the org max API version for standard queries', async () => {
    setApiVersion('66.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://standard-fallback.example.my.salesforce.com',
      username: 'standard.fallback@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '64.0' }]
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/v66.0/query')) {
        return {
          statusCode: 404,
          body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/v64.0/query')) {
        return {
          statusCode: 200,
          body: {
            records: [{ Id: '005000000000001AAA', Name: 'Ada Lovelace', Username: 'ada@example.com', IsActive: true }]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const users = await listActiveUsers(legacyAuth, 'ada', 25);

    assert.equal(users.length, 1);
    assert.equal(getEffectiveApiVersion(legacyAuth), '64.0');
    assert.ok(
      getApiVersionFallbackWarning(legacyAuth)?.includes('sourceApiVersion 66.0 > org max 64.0'),
      'expected API version fallback warning for standard query flow'
    );
    assert.equal(calls.filter(call => call.path.includes('/services/data/v66.0/query')).length, 1);
    assert.equal(calls.filter(call => call.path.includes('/services/data/v64.0/query')).length, 1);
  });

  test('getUserTraceFlagStatus parses active status and metadata', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            records: [
              {
                Id: '7tf000000000001AAA',
                StartDate: '2026-02-19T16:00:00.000Z',
                ExpirationDate: '2099-02-19T18:00:00.000Z',
                DebugLevel: { DeveloperName: 'ALV_E2E' }
              }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getUserTraceFlagStatus(auth, '005000000000001AAA');
    assert.ok(status);
    assert.equal(status?.traceFlagId, '7tf000000000001AAA');
    assert.equal(status?.debugLevelName, 'ALV_E2E');
    assert.equal(status?.isActive, true);
  });

  test('listDebugLevels falls back to the org max API version for tooling queries', async () => {
    setApiVersion('66.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://tooling-fallback.example.my.salesforce.com',
      username: 'tooling.fallback@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '64.0' }]
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/v66.0/tooling/query')) {
        return {
          statusCode: 404,
          body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/v64.0/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            records: [{ DeveloperName: 'ALV_VERBOSE' }]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const names = await listDebugLevels(legacyAuth);

    assert.deepEqual(names, ['ALV_VERBOSE']);
    assert.equal(getEffectiveApiVersion(legacyAuth), '64.0');
    assert.ok(
      getApiVersionFallbackWarning(legacyAuth)?.includes('sourceApiVersion 66.0 > org max 64.0'),
      'expected API version fallback warning for tooling query flow'
    );
    assert.equal(calls.filter(call => call.path.includes('/services/data/v66.0/tooling/query')).length, 1);
    assert.equal(calls.filter(call => call.path.includes('/services/data/v64.0/tooling/query')).length, 1);
  });

  test('getActiveUserDebugLevel caches repeated reads for the same user', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    let userQueryCount = 0;
    let traceFlagQueryCount = 0;
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("FROM User WHERE Username = 'user@example.com'")) {
          userQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA'")) {
          traceFlagQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000001AAA',
                  StartDate: '2026-03-25T00:00:00.000+0000',
                  ExpirationDate: '2099-03-25T01:00:00.000+0000',
                  DebugLevel: { DeveloperName: 'ALV_E2E' }
                }
              ]
            }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const first = await getActiveUserDebugLevel(auth);
    const second = await getActiveUserDebugLevel(auth);

    assert.equal(first, 'ALV_E2E');
    assert.equal(second, 'ALV_E2E');
    assert.equal(userQueryCount, 1, 'expected current user lookup to stay cached');
    assert.equal(traceFlagQueryCount, 1, 'expected active debug level lookup to stay cached');
  });

  test('upsertUserTraceFlag invalidates the cached active debug level', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    let traceFlagQueryCount = 0;
    let activeDebugLevelName = 'ALV_OLD';
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("FROM User WHERE Username = 'user@example.com'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM DebugLevel WHERE DeveloperName = 'ALV_NEW'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7dl000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7tf000000000001AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG'")) {
          traceFlagQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000001AAA',
                  StartDate: '2026-03-25T00:00:00.000+0000',
                  ExpirationDate: '2099-03-25T01:00:00.000+0000',
                  DebugLevel: { DeveloperName: activeDebugLevelName }
                }
              ]
            }
          };
        }
      }
      if (
        req.method === 'PATCH' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000001AAA')
      ) {
        activeDebugLevelName = 'ALV_NEW';
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        return {
          statusCode: 204
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const before = await getActiveUserDebugLevel(auth);
    await upsertUserTraceFlag(auth, {
      userId: '005000000000001AAA',
      debugLevelName: 'ALV_NEW',
      ttlMinutes: 30
    });
    const after = await getActiveUserDebugLevel(auth);

    assert.equal(before, 'ALV_OLD');
    assert.equal(after, 'ALV_NEW');
    assert.equal(traceFlagQueryCount, 2, 'expected a fresh trace-flag read after invalidation');
  });

  test('upsertTraceFlag invalidates the cached active debug level for current special-target users', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    let traceFlagQueryCount = 0;
    let activeDebugLevelName = 'ALV_OLD';
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("FROM User WHERE Username = 'user@example.com'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM DebugLevel WHERE DeveloperName = 'ALV_NEW'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7dl000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7tf000000000001AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG'")) {
          traceFlagQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000001AAA',
                  StartDate: '2026-03-25T00:00:00.000+0000',
                  ExpirationDate: '2099-03-25T01:00:00.000+0000',
                  DebugLevel: { DeveloperName: activeDebugLevelName }
                }
              ]
            }
          };
        }
      }
      if (
        req.method === 'PATCH' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000001AAA')
      ) {
        activeDebugLevelName = 'ALV_NEW';
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        return {
          statusCode: 204
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const before = await getActiveUserDebugLevel(auth);
    await upsertTraceFlag(auth, {
      target: { type: 'platformIntegration' },
      debugLevelName: 'ALV_NEW',
      ttlMinutes: 30
    });
    const after = await getActiveUserDebugLevel(auth);

    assert.equal(before, 'ALV_OLD');
    assert.equal(after, 'ALV_NEW');
    assert.equal(traceFlagQueryCount, 2, 'expected a fresh trace-flag read after special-target invalidation');
  });

  test('upsertTraceFlag invalidates the cached active debug level after a partial special-target failure', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    let traceFlagQueryCount = 0;
    let activeDebugLevelName = 'ALV_OLD';
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("FROM User WHERE Username = 'user@example.com'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }, { Id: '005000000000002AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM DebugLevel WHERE DeveloperName = 'ALV_NEW'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7dl000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7tf000000000001AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM TraceFlag WHERE TracedEntityId = '005000000000002AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7tf000000000002AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG'")) {
          traceFlagQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000001AAA',
                  StartDate: '2026-03-25T00:00:00.000+0000',
                  ExpirationDate: '2099-03-25T01:00:00.000+0000',
                  DebugLevel: { DeveloperName: activeDebugLevelName }
                }
              ]
            }
          };
        }
      }
      if (
        req.method === 'PATCH' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000001AAA')
      ) {
        activeDebugLevelName = 'ALV_NEW';
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        return {
          statusCode: 204
        };
      }
      if (
        req.method === 'PATCH' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000002AAA')
      ) {
        return {
          statusCode: 200,
          body: { success: false, errors: [{ message: 'boom' }] }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const before = await getActiveUserDebugLevel(auth);
    await assert.rejects(
      async () =>
        await upsertTraceFlag(auth, {
          target: { type: 'platformIntegration' },
          debugLevelName: 'ALV_NEW',
          ttlMinutes: 30
        }),
      /Failed to update USER_DEBUG TraceFlag/
    );
    const after = await getActiveUserDebugLevel(auth);

    assert.equal(before, 'ALV_OLD');
    assert.equal(after, 'ALV_NEW');
    assert.equal(
      traceFlagQueryCount,
      2,
      'expected a fresh trace-flag read after the partially successful special-target write'
    );
  });

  test('removeTraceFlags invalidates the cached active debug level after a partial special-target delete failure', async () => {
    (workspace.getConfiguration as any) = () => ({ get: () => undefined });
    let traceFlagQueryCount = 0;
    let currentUserHasActiveTraceFlag = true;
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/services/data/v')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("FROM User WHERE Username = 'user@example.com'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }]
            }
          };
        }
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000001AAA' }, { Id: '005000000000002AAA' }]
            }
          };
        }
        if (soql.includes("SELECT Id FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '7tf000000000001AAA' }, { Id: '7tf000000000002AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000001AAA' AND LogType = 'USER_DEBUG'")) {
          traceFlagQueryCount++;
          return {
            statusCode: 200,
            body: {
              records: currentUserHasActiveTraceFlag
                ? [
                    {
                      Id: '7tf000000000001AAA',
                      StartDate: '2026-03-25T00:00:00.000+0000',
                      ExpirationDate: '2099-03-25T01:00:00.000+0000',
                      DebugLevel: { DeveloperName: 'ALV_OLD' }
                    }
                  ]
                : []
            }
          };
        }
      }
      if (
        req.method === 'DELETE' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000001AAA')
      ) {
        currentUserHasActiveTraceFlag = false;
        return {
          statusCode: 204
        };
      }
      if (
        req.method === 'DELETE' &&
        req.path.endsWith('/services/data/v64.0/tooling/sobjects/TraceFlag/7tf000000000002AAA')
      ) {
        return {
          statusCode: 500,
          body: '{"message":"boom"}'
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const before = await getActiveUserDebugLevel(auth);
    await assert.rejects(async () => await removeTraceFlags(auth, { type: 'platformIntegration' }), /HTTP 500/);
    const after = await getActiveUserDebugLevel(auth);

    assert.equal(before, 'ALV_OLD');
    assert.equal(after, undefined);
    assert.equal(
      traceFlagQueryCount,
      2,
      'expected a fresh trace-flag read after the partially successful special-target delete'
    );
  });

  test('getTraceFlagTargetStatus resolves Automated Process across all active matches and aggregates USER_DEBUG status', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'AutomatedProcess')) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }] }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000003AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000003AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_AUTOPROC' }
                }
              ]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000004AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000004AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_AUTOPROC' }
                }
              ]
            }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'automatedProcess' });
    assert.equal(status.target.type, 'automatedProcess');
    assert.equal(status.targetLabel, 'Automated Process');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.traceFlagId, undefined);
    assert.equal(status.debugLevelName, 'ALV_AUTOPROC');
    assert.equal(status.resolvedTargetCount, 2);
    assert.equal(status.activeTargetCount, 2);
    assert.equal(status.debugLevelMixed, false);
    assert.equal(status.isActive, true);
    assert.ok(
      calls.some(call => {
        const soql = decodeSoql(call.path);
        return isSpecialTargetUserResolutionQuery(soql, 'AutomatedProcess');
      }),
      'expected Automated Process user resolution query by active user type only'
    );
  });

  test('getTraceFlagTargetStatus resolves Platform Integration by active user type', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000004AAA' }] }
          };
        }
        if (soql.includes('FROM TraceFlag')) {
          return {
            statusCode: 200,
            body: { records: [] }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'platformIntegration' });
    assert.equal(status.target.type, 'platformIntegration');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.traceFlagId, undefined);
    assert.equal(status.resolvedTargetCount, 1);
    assert.equal(status.activeTargetCount, 0);
    assert.equal(status.isActive, false);
    assert.ok(
      calls.some(call => {
        const soql = decodeSoql(call.path);
        return isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser');
      }),
      'expected Platform Integration lookup by active user type only'
    );
  });

  test('getTraceFlagTargetStatus reports mixed special-target status when resolved users differ', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000003AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000003AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_PLATFORM_A' }
                }
              ]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000004AAA'")) {
          return {
            statusCode: 200,
            body: { records: [] }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'platformIntegration' });
    assert.equal(status.target.type, 'platformIntegration');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.traceFlagId, undefined);
    assert.equal(status.resolvedTargetCount, 2);
    assert.equal(status.activeTargetCount, 1);
    assert.equal(status.debugLevelMixed, true);
    assert.equal(status.debugLevelName, undefined);
    assert.equal(status.isActive, true);
  });

  test('getTraceFlagTargetStatus keeps a shared start time when active special-target flags only differ by expiration', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000003AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000003AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_PLATFORM_SHARED' }
                }
              ]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000004AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000004AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T19:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_PLATFORM_SHARED' }
                }
              ]
            }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'platformIntegration' });
    assert.equal(status.target.type, 'platformIntegration');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.resolvedTargetCount, 2);
    assert.equal(status.activeTargetCount, 2);
    assert.equal(status.debugLevelMixed, false);
    assert.equal(status.debugLevelName, 'ALV_PLATFORM_SHARED');
    assert.equal(status.startDate, '2026-02-19T16:00:00.000Z');
    assert.equal(status.expirationDate, undefined);
    assert.equal(status.isActive, true);
  });

  test('getTraceFlagTargetStatus keeps a shared expiration when active special-target flags only differ by start time', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'AutomatedProcess')) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }] }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000003AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000003AAA',
                  StartDate: '2026-02-19T16:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_AUTOPROC_SHARED' }
                }
              ]
            }
          };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000004AAA'")) {
          return {
            statusCode: 200,
            body: {
              records: [
                {
                  Id: '7tf000000000004AAA',
                  StartDate: '2026-02-19T17:00:00.000Z',
                  ExpirationDate: '2099-02-19T18:00:00.000Z',
                  DebugLevel: { DeveloperName: 'ALV_AUTOPROC_SHARED' }
                }
              ]
            }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'automatedProcess' });
    assert.equal(status.target.type, 'automatedProcess');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.resolvedTargetCount, 2);
    assert.equal(status.activeTargetCount, 2);
    assert.equal(status.debugLevelMixed, false);
    assert.equal(status.debugLevelName, 'ALV_AUTOPROC_SHARED');
    assert.equal(status.startDate, undefined);
    assert.equal(status.expirationDate, '2099-02-19T18:00:00.000Z');
    assert.equal(status.isActive, true);
  });

  test('getTraceFlagTargetStatus marks special target unavailable when no active users match', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: { records: [] }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'platformIntegration' });
    assert.equal(status.target.type, 'platformIntegration');
    assert.equal(status.targetAvailable, false);
    assert.equal(status.traceFlagId, undefined);
    assert.equal(status.resolvedTargetCount, 0);
    assert.equal(status.activeTargetCount, 0);
    assert.equal(status.isActive, false);
  });

  test('listDebugLevelDetails parses all editable DebugLevel fields', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            records: [
              {
                Id: '7dl000000000001AAA',
                DeveloperName: 'ALV_VERBOSE',
                MasterLabel: 'ALV Verbose',
                Language: 'en_US',
                Workflow: 'WARN',
                Validation: 'INFO',
                Callout: 'ERROR',
                ApexCode: 'DEBUG',
                ApexProfiling: 'INFO',
                Visualforce: 'WARN',
                System: 'DEBUG',
                Database: 'FINE',
                Wave: 'ERROR',
                Nba: 'WARN',
                DataAccess: 'INFO'
              }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const records = await listDebugLevelDetails(auth);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      id: '7dl000000000001AAA',
      developerName: 'ALV_VERBOSE',
      masterLabel: 'ALV Verbose',
      language: 'en_US',
      workflow: 'WARN',
      validation: 'INFO',
      callout: 'ERROR',
      apexCode: 'DEBUG',
      apexProfiling: 'INFO',
      visualforce: 'WARN',
      system: 'DEBUG',
      database: 'FINE',
      wave: 'ERROR',
      nba: 'WARN',
      dataAccess: 'INFO'
    });
  });

  test('listDebugLevelDetails upgrades the API version when extended fields require a newer one', async () => {
    setApiVersion('60.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://legacy-api.example.my.salesforce.com',
      username: 'legacy.user@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '60.0' }, { version: '66.0' }]
        };
      }
      if (req.method === 'GET' && req.path.includes('/services/data/v66.0/tooling/query')) {
        return {
          statusCode: 200,
          body: {
            records: [
              {
                Id: '7dl000000000001AAA',
                DeveloperName: 'ALV_VERBOSE',
                MasterLabel: 'ALV Verbose',
                Language: 'en_US',
                Workflow: 'WARN',
                Validation: 'INFO',
                Callout: 'ERROR',
                ApexCode: 'DEBUG',
                ApexProfiling: 'INFO',
                Visualforce: 'WARN',
                System: 'DEBUG',
                Database: 'FINE',
                Wave: 'ERROR',
                Nba: 'WARN',
                DataAccess: 'INFO'
              }
            ]
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const records = await listDebugLevelDetails(legacyAuth);

    assert.equal(records.length, 1);
    assert.ok(
      calls.some(call => call.path === '/services/data'),
      'expected org API discovery request'
    );
    assert.ok(
      calls.some(call => call.path.includes('/services/data/v66.0/tooling/query')),
      'expected DebugLevel query to use upgraded API version'
    );
  });

  test('createDebugLevel creates the tooling record with the full editable DebugLevel payload', async () => {
    setApiVersion('60.0');
    const httpCalls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '60.0' }, { version: '66.0' }]
        };
      }
      if (req.method === 'POST' && req.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DeveloperName, 'ALV_CUSTOM');
        assert.equal(parsed.MasterLabel, 'ALV Custom');
        return {
          statusCode: 201,
          body: {
            success: true,
            id: '7dl000000000999AAA'
          }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const created = await createDebugLevel(auth, {
      developerName: 'ALV_CUSTOM',
      masterLabel: 'ALV Custom',
      language: 'en_US',
      workflow: 'WARN',
      validation: 'INFO',
      callout: 'ERROR',
      apexCode: 'DEBUG',
      apexProfiling: 'INFO',
      visualforce: 'WARN',
      system: 'DEBUG',
      database: 'FINE',
      wave: 'ERROR',
      nba: 'WARN',
      dataAccess: 'INFO'
    });

    assert.equal(created.id, '7dl000000000999AAA');
    assert.ok(
      httpCalls.some(call => call.method === 'POST' && call.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel')),
      'expected DebugLevel tooling create request'
    );
    assert.ok(
      httpCalls.some(call => call.path === '/services/data'),
      'expected org API discovery before DebugLevel create'
    );
  });

  test('createDebugLevel falls back to the org max API version for tooling writes', async () => {
    setApiVersion('66.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://tooling-write-create.example.my.salesforce.com',
      username: 'tooling.write.create@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'POST' && req.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel')) {
        return {
          statusCode: 404,
          body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]
        };
      }
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '64.0' }]
        };
      }
      if (req.method === 'POST' && req.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel')) {
        return {
          statusCode: 201,
          body: { success: true, id: '7dl000000000fallbackAAA' }
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const created = await createDebugLevel(legacyAuth, {
      developerName: 'ALV_FALLBACK_CREATE',
      masterLabel: 'ALV Fallback Create',
      language: 'en_US',
      workflow: 'WARN',
      validation: 'INFO',
      callout: 'ERROR',
      apexCode: 'DEBUG',
      apexProfiling: 'INFO',
      visualforce: 'WARN',
      system: 'DEBUG',
      database: 'FINE',
      wave: 'ERROR',
      nba: 'WARN',
      dataAccess: 'INFO'
    });

    assert.equal(created.id, '7dl000000000fallbackAAA');
    assert.equal(getEffectiveApiVersion(legacyAuth), '64.0');
    assert.equal(calls.filter(call => call.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel')).length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel')).length, 1);
  });

  test('updateDebugLevel updates the tooling record with the full editable DebugLevel payload', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'PATCH' && req.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DeveloperName, 'ALV_CUSTOM');
        assert.equal(parsed.MasterLabel, 'ALV Custom');
        assert.equal(parsed.Language, 'pt_BR');
        assert.equal(parsed.DataAccess, 'WARN');
        return {
          statusCode: 204
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    await updateDebugLevel(auth, '7dl000000000001AAA', {
      developerName: 'ALV_CUSTOM',
      masterLabel: 'ALV Custom',
      language: 'pt_BR',
      workflow: 'INFO',
      validation: 'WARN',
      callout: 'ERROR',
      apexCode: 'FINEST',
      apexProfiling: 'DEBUG',
      visualforce: 'WARN',
      system: 'DEBUG',
      database: 'ERROR',
      wave: 'NONE',
      nba: 'INFO',
      dataAccess: 'WARN'
    });

    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  });

  test('updateDebugLevel falls back to the org max API version for tooling writes', async () => {
    setApiVersion('66.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://tooling-write-update.example.my.salesforce.com',
      username: 'tooling.write.update@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'PATCH' && req.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        return {
          statusCode: 404,
          body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]
        };
      }
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '64.0' }]
        };
      }
      if (req.method === 'PATCH' && req.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    await updateDebugLevel(legacyAuth, '7dl000000000001AAA', {
      developerName: 'ALV_FALLBACK_UPDATE',
      masterLabel: 'ALV Fallback Update',
      language: 'pt_BR',
      workflow: 'INFO',
      validation: 'WARN',
      callout: 'ERROR',
      apexCode: 'FINEST',
      apexProfiling: 'DEBUG',
      visualforce: 'WARN',
      system: 'DEBUG',
      database: 'ERROR',
      wave: 'NONE',
      nba: 'INFO',
      dataAccess: 'WARN'
    });

    assert.equal(getEffectiveApiVersion(legacyAuth), '64.0');
    assert.equal(
      calls.filter(call => call.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')).length,
      1
    );
    assert.equal(
      calls.filter(call => call.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')).length,
      1
    );
  });

  test('deleteDebugLevel deletes the tooling record via the Tooling API client', async () => {
    setApiVersion('60.0');
    const httpCalls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '60.0' }, { version: '66.0' }]
        };
      }
      if (req.method === 'DELETE' && req.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    await deleteDebugLevel(auth, '7dl000000000001AAA');
    assert.ok(
      httpCalls.some(call => call.path === '/services/data'),
      'expected org API discovery before DebugLevel delete'
    );
    assert.ok(
      httpCalls.some(
        call => call.method === 'DELETE' && call.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')
      ),
      'expected DebugLevel tooling delete request'
    );
  });

  test('deleteDebugLevel falls back to the org max API version for tooling writes', async () => {
    setApiVersion('66.0');
    const legacyAuth: OrgAuth = {
      ...auth,
      instanceUrl: 'https://tooling-write-delete.example.my.salesforce.com',
      username: 'tooling.write.delete@example.com'
    };
    const calls = installHttpsStub(req => {
      if (req.method === 'DELETE' && req.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        return {
          statusCode: 404,
          body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]
        };
      }
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '64.0' }]
        };
      }
      if (req.method === 'DELETE' && req.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    await deleteDebugLevel(legacyAuth, '7dl000000000001AAA');

    assert.equal(getEffectiveApiVersion(legacyAuth), '64.0');
    assert.equal(
      calls.filter(call => call.path.endsWith('/services/data/v66.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')).length,
      1
    );
    assert.equal(
      calls.filter(call => call.path.endsWith('/services/data/v64.0/tooling/sobjects/DebugLevel/7dl000000000001AAA')).length,
      1
    );
  });

  test('upsertUserTraceFlag updates existing USER_DEBUG flag', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes('FROM TraceFlag')) {
          return { statusCode: 200, body: { records: [{ Id: '7tf000000000001AAA' }] } };
        }
      }
      if (req.method === 'PATCH' && req.path.includes('/tooling/sobjects/TraceFlag/7tf000000000001AAA')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        assert.ok(typeof parsed.StartDate === 'string');
        assert.ok(typeof parsed.ExpirationDate === 'string');
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertUserTraceFlag(auth, {
      userId: '005000000000001AAA',
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 45
    });
    assert.equal(result.created, false);
    assert.equal(result.traceFlagId, '7tf000000000001AAA');
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  });

  test('upsertUserTraceFlag creates USER_DEBUG flag when none exists', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes('FROM TraceFlag')) {
          return { statusCode: 200, body: { records: [] } };
        }
      }
      if (req.method === 'POST' && req.path.endsWith('/tooling/sobjects/TraceFlag')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.TracedEntityId, '005000000000001AAA');
        assert.equal(parsed.LogType, 'USER_DEBUG');
        return { statusCode: 201, body: { success: true, id: '7tf000000000999AAA' } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertUserTraceFlag(auth, {
      userId: '005000000000001AAA',
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 30
    });
    assert.equal(result.created, true);
    assert.equal(result.traceFlagId, '7tf000000000999AAA');
  });

  test('upsertTraceFlag applies USER_DEBUG flags across all resolved Automated Process targets', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'AutomatedProcess')) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }] }
          };
        }
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000003AAA'")) {
          return { statusCode: 200, body: { records: [{ Id: '7tf000000000003AAA' }] } };
        }
        if (soql.includes("FROM TraceFlag WHERE TracedEntityId = '005000000000004AAA'")) {
          return { statusCode: 200, body: { records: [] } };
        }
      }
      if (req.method === 'PATCH' && req.path.includes('/tooling/sobjects/TraceFlag/7tf000000000003AAA')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.DebugLevelId, '7dl000000000001AAA');
        return { statusCode: 204 };
      }
      if (req.method === 'POST' && req.path.endsWith('/tooling/sobjects/TraceFlag')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.TracedEntityId, '005000000000004AAA');
        assert.equal(parsed.LogType, 'USER_DEBUG');
        return { statusCode: 201, body: { success: true, id: '7tf000000000004AAA' } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertTraceFlag(auth, {
      target: { type: 'automatedProcess' },
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 30
    });
    assert.equal(result.created, false);
    assert.equal(result.traceFlagId, undefined);
    assert.deepEqual(result.traceFlagIds, ['7tf000000000003AAA', '7tf000000000004AAA']);
    assert.equal(result.createdCount, 1);
    assert.equal(result.updatedCount, 1);
    assert.equal(result.resolvedTargetCount, 2);
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });

  test('removeUserTraceFlags deletes all USER_DEBUG flags for user', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        return {
          statusCode: 200,
          body: { records: [{ Id: '7tf000000000001AAA' }, { Id: '7tf000000000002AAA' }] }
        };
      }
      if (req.method === 'DELETE' && req.path.includes('/tooling/sobjects/TraceFlag/')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const removed = await removeUserTraceFlags(auth, '005000000000001AAA');
    assert.equal(removed, 2);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
  });

  test('removeTraceFlags deletes USER_DEBUG flags across all resolved Platform Integration targets', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return {
            statusCode: 200,
            body: {
              records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }]
            }
          };
        }
      }
      if (req.method === 'GET' && req.path.includes('/tooling/query')) {
        const soql = decodeSoql(req.path);
        if (soql.includes("TracedEntityId = '005000000000003AAA'")) {
          return { statusCode: 200, body: { records: [{ Id: '7tf000000000101AAA' }, { Id: '7tf000000000102AAA' }] } };
        }
        if (soql.includes("TracedEntityId = '005000000000004AAA'")) {
          return { statusCode: 200, body: { records: [{ Id: '7tf000000000201AAA' }] } };
        }
      }
      if (req.method === 'DELETE' && req.path.includes('/tooling/sobjects/TraceFlag/')) {
        return { statusCode: 204 };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await removeTraceFlags(auth, { type: 'platformIntegration' });
    assert.equal(result.removedCount, 3);
    assert.equal(result.resolvedTargetCount, 2);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 3);
  });

  test('removeTraceFlags surfaces a friendly error when Platform Integration is unavailable', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (isSpecialTargetUserResolutionQuery(soql, 'CloudIntegrationUser')) {
          return { statusCode: 200, body: { records: [] } };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    await assert.rejects(
      async () => await removeTraceFlags(auth, { type: 'platformIntegration' }),
      /Platform Integration/
    );
  });
});
