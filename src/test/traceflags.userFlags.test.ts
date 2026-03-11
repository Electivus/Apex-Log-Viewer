import assert from 'assert/strict';
import { EventEmitter } from 'events';
import { __resetExecFileImplForTests, __setExecFileImplForTests } from '../salesforce/exec';
import type { OrgAuth } from '../salesforce/types';
import {
  __resetApiVersionFallbackStateForTests,
  __resetHttpsRequestImplForTests,
  __setHttpsRequestImplForTests,
  setApiVersion
} from '../salesforce/http';
import {
  __resetDebugLevelApiVersionCacheForTests,
  __resetUserIdCacheForTests,
  createDebugLevel,
  deleteDebugLevel,
  getTraceFlagTargetStatus,
  getUserTraceFlagStatus,
  listDebugLevelDetails,
  listActiveUsers,
  removeTraceFlags,
  removeUserTraceFlags,
  updateDebugLevel,
  upsertTraceFlag,
  upsertUserTraceFlag
} from '../salesforce/traceflags';

type StubRequest = {
  method: string;
  path: string;
  body: string;
};

function installHttpsStub(
  responder: (req: StubRequest) => { statusCode: number; body?: unknown }
): StubRequest[] {
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

type ExecCall = {
  program: string;
  args: string[];
};

function installExecStub(
  responder: (call: ExecCall) => { stdout?: string; stderr?: string; code?: number }
): ExecCall[] {
  const calls: ExecCall[] = [];
  __setExecFileImplForTests(((program: string, args: readonly string[] | undefined, _opts: any, cb: any) => {
    const call: ExecCall = {
      program,
      args: Array.isArray(args) ? [...args] : []
    };
    calls.push(call);
    try {
      const response = responder(call);
      if (response.code && response.code !== 0) {
        const err: any = new Error(response.stderr || 'command failed');
        err.code = response.code;
        cb(err, response.stdout || '', response.stderr || '');
      } else {
        cb(null, response.stdout || '', response.stderr || '');
      }
    } catch (e) {
      cb(e, '', '');
    }
    return undefined as any;
  }) as any);
  return calls;
}

suite('traceflags user management', () => {
  const auth: OrgAuth = {
    accessToken: 'token',
    instanceUrl: 'https://example.my.salesforce.com',
    username: 'user@example.com'
  };

  teardown(() => {
    __resetHttpsRequestImplForTests();
    __resetExecFileImplForTests();
    __resetApiVersionFallbackStateForTests();
    __resetDebugLevelApiVersionCacheForTests();
    __resetUserIdCacheForTests();
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

  test('getTraceFlagTargetStatus resolves Automated Process with the expected system user type and reads USER_DEBUG status', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (
          soql.includes("FROM User WHERE Name = 'Automated Process'") &&
          soql.includes("UserType = 'AutomatedProcess'")
        ) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }] }
          };
        }
        if (soql.includes('FROM TraceFlag')) {
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
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'automatedProcess' });
    assert.equal(status.target.type, 'automatedProcess');
    assert.equal(status.targetLabel, 'Automated Process');
    assert.equal(status.targetAvailable, true);
    assert.equal(status.traceFlagId, '7tf000000000003AAA');
    assert.equal(status.debugLevelName, 'ALV_AUTOPROC');
    assert.equal(status.isActive, true);
    assert.ok(
      calls.some(call => {
        const soql = decodeSoql(call.path);
        return soql.includes("FROM User WHERE Name = 'Automated Process'") && soql.includes("UserType = 'AutomatedProcess'");
      }),
      'expected Automated Process user resolution query with system user type'
    );
  });

  test('getTraceFlagTargetStatus falls back to Platform Integration User when needed', async () => {
    const calls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (
          soql.includes("FROM User WHERE Name = 'Platform Integration'") &&
          soql.includes("UserType = 'CloudIntegrationUser'")
        ) {
          return {
            statusCode: 200,
            body: { records: [] }
          };
        }
        if (
          soql.includes("FROM User WHERE Name = 'Platform Integration User'") &&
          soql.includes("UserType = 'CloudIntegrationUser'")
        ) {
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
    assert.equal(status.isActive, false);
    assert.ok(
      calls.some(call => {
        const soql = decodeSoql(call.path);
        return (
          soql.includes("FROM User WHERE Name = 'Platform Integration User'") &&
          soql.includes("UserType = 'CloudIntegrationUser'")
        );
      }),
      'expected Platform Integration fallback query with cloud integration user type'
    );
  });

  test('getTraceFlagTargetStatus treats ambiguous special-target matches as unavailable', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (
          soql.includes("FROM User WHERE Name = 'Automated Process'") &&
          soql.includes("UserType = 'AutomatedProcess'")
        ) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }, { Id: '005000000000004AAA' }] }
          };
        }
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const status = await getTraceFlagTargetStatus(auth, { type: 'automatedProcess' });
    assert.equal(status.target.type, 'automatedProcess');
    assert.equal(status.targetAvailable, false);
    assert.equal(status.traceFlagId, undefined);
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
    assert.ok(calls.some(call => call.path === '/services/data'), 'expected org API discovery request');
    assert.ok(
      calls.some(call => call.path.includes('/services/data/v66.0/tooling/query')),
      'expected DebugLevel query to use upgraded API version'
    );
  });

  test('createDebugLevel uses sf CLI with the full editable DebugLevel payload', async () => {
    setApiVersion('60.0');
    const httpCalls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '60.0' }, { version: '66.0' }]
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });
    const calls = installExecStub(call => {
      if (call.program === 'sf' && call.args[0] === 'data' && call.args[1] === 'create' && call.args[2] === 'record') {
        return {
          stdout: JSON.stringify({
            result: {
              success: true,
              id: '7dl000000000999AAA'
            }
          })
        };
      }
      throw new Error(`Unexpected command: ${call.program} ${call.args.join(' ')}`);
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
    const createCall = calls.find(call => call.args[0] === 'data' && call.args[1] === 'create');
    const createCommandText = calls.map(call => [call.program, ...call.args].join(' ')).join('\n');
    assert.ok(createCall || /data create record/.test(createCommandText), 'expected DebugLevel create command');
    assert.match(createCommandText, /--use-tooling-api/);
    assert.match(createCommandText, /--target-org/);
    assert.match(createCommandText, /user@example\.com/);
    assert.match(createCommandText, /--api-version 66\.0/);
    assert.match(createCommandText, /--sobject/);
    assert.match(createCommandText, /DebugLevel/);
    assert.match(createCommandText, /DeveloperName=ALV_CUSTOM/);
    assert.match(createCommandText, /MasterLabel='ALV Custom'/);
    assert.match(createCommandText, /DataAccess=INFO/);
    assert.ok(httpCalls.some(call => call.path === '/services/data'), 'expected org API discovery before CLI create');
  });

  test('updateDebugLevel uses sf CLI with the full editable DebugLevel payload', async () => {
    const calls = installExecStub(call => {
      if (call.program === 'sf' && call.args[0] === 'data' && call.args[1] === 'update' && call.args[2] === 'record') {
        return {
          stdout: JSON.stringify({
            result: {
              success: true
            }
          })
        };
      }
      throw new Error(`Unexpected command: ${call.program} ${call.args.join(' ')}`);
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

    const updateCall = calls.find(call => call.args[0] === 'data' && call.args[1] === 'update');
    const updateCommandText = calls.map(call => [call.program, ...call.args].join(' ')).join('\n');
    assert.ok(updateCall || /data update record/.test(updateCommandText), 'expected DebugLevel update command');
    assert.match(updateCommandText, /--record-id/);
    assert.match(updateCommandText, /7dl000000000001AAA/);
    assert.match(updateCommandText, /DeveloperName=ALV_CUSTOM/);
    assert.match(updateCommandText, /MasterLabel='ALV Custom'/);
    assert.match(updateCommandText, /Language=pt_BR/);
    assert.match(updateCommandText, /DataAccess=WARN/);
  });

  test('deleteDebugLevel deletes the tooling record with sf CLI', async () => {
    setApiVersion('60.0');
    const httpCalls = installHttpsStub(req => {
      if (req.method === 'GET' && req.path === '/services/data') {
        return {
          statusCode: 200,
          body: [{ version: '60.0' }, { version: '66.0' }]
        };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });
    const calls = installExecStub(call => {
      if (call.program === 'sf' && call.args[0] === 'data' && call.args[1] === 'delete' && call.args[2] === 'record') {
        return {
          stdout: JSON.stringify({
            result: {
              success: true
            }
          })
        };
      }
      throw new Error(`Unexpected command: ${call.program} ${call.args.join(' ')}`);
    });

    await deleteDebugLevel(auth, '7dl000000000001AAA');
    const deleteCall = calls.find(call => call.args[0] === 'data' && call.args[1] === 'delete');
    const deleteCommandText = calls.map(call => [call.program, ...call.args].join(' ')).join('\n');
    assert.ok(deleteCall || /data delete record/.test(deleteCommandText), 'expected DebugLevel delete command');
    assert.match(deleteCommandText, /--record-id/);
    assert.match(deleteCommandText, /7dl000000000001AAA/);
    assert.match(deleteCommandText, /--api-version 66\.0/);
    assert.ok(httpCalls.some(call => call.path === '/services/data'), 'expected org API discovery before CLI delete');
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

  test('upsertTraceFlag creates USER_DEBUG flag for Automated Process target', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (
          soql.includes("FROM User WHERE Name = 'Automated Process'") &&
          soql.includes("UserType = 'AutomatedProcess'")
        ) {
          return {
            statusCode: 200,
            body: { records: [{ Id: '005000000000003AAA' }] }
          };
        }
        if (soql.includes('FROM DebugLevel')) {
          return { statusCode: 200, body: { records: [{ Id: '7dl000000000001AAA' }] } };
        }
        if (soql.includes('FROM TraceFlag')) {
          return { statusCode: 200, body: { records: [] } };
        }
      }
      if (req.method === 'POST' && req.path.endsWith('/tooling/sobjects/TraceFlag')) {
        const parsed = JSON.parse(req.body);
        assert.equal(parsed.TracedEntityId, '005000000000003AAA');
        assert.equal(parsed.LogType, 'USER_DEBUG');
        return { statusCode: 201, body: { success: true, id: '7tf000000000003AAA' } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    });

    const result = await upsertTraceFlag(auth, {
      target: { type: 'automatedProcess' },
      debugLevelName: 'ALV_E2E',
      ttlMinutes: 30
    });
    assert.equal(result.created, true);
    assert.equal(result.traceFlagId, '7tf000000000003AAA');
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

  test('removeTraceFlags surfaces a friendly error when Platform Integration is unavailable', async () => {
    installHttpsStub(req => {
      if (req.method === 'GET' && req.path.includes('/query?q=')) {
        const soql = decodeSoql(req.path);
        if (
          soql.includes("FROM User WHERE Name = 'Platform Integration'") &&
          soql.includes("UserType = 'CloudIntegrationUser'")
        ) {
          return { statusCode: 200, body: { records: [] } };
        }
        if (
          soql.includes("FROM User WHERE Name = 'Platform Integration User'") &&
          soql.includes("UserType = 'CloudIntegrationUser'")
        ) {
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
