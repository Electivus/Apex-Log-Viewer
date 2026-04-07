import assert from 'assert/strict';
import proxyquire from 'proxyquire';
import { createEmptyDebugLevelRecord } from '../shared/debugLevelPresets';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

function loadDebugFlagsPanel(stubs?: {
  traceflags?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  cli?: Record<string, unknown>;
}) {
  return proxyquireStrict('../panel/DebugFlagsPanel', {
    '../../../../src/salesforce/traceflags': stubs?.traceflags ?? {},
    '../shared/telemetry': stubs?.telemetry ?? {},
    '../runtime/runtimeClient': stubs?.runtime ?? {},
    '../../../../src/salesforce/cli': stubs?.cli ?? {}
  }) as typeof import('../panel/DebugFlagsPanel');
}

suite('DebugFlagsPanel', () => {
  test('sendDebugLevelData ignores stale bootstrap results', async () => {
    let resolveDetails: ((value: ReturnType<typeof createEmptyDebugLevelRecord>[]) => void) | undefined;
    let resolveActive: ((value: string | undefined) => void) | undefined;

    const { DebugFlagsPanel } = loadDebugFlagsPanel({
      traceflags: {
        listDebugLevelDetails: async () =>
          await new Promise(resolve => {
            resolveDetails = resolve;
          }),
        getActiveUserDebugLevel: async () =>
          await new Promise(resolve => {
            resolveActive = resolve;
          })
      }
    });

    const posted: any[] = [];
    const panelLike = {
      disposed: false,
      orgBootstrapToken: 2,
      post: (message: any) => {
        posted.push(message);
      }
    };

    const promise = (DebugFlagsPanel as any).prototype.sendDebugLevelData.call(panelLike, {} as any, undefined, 1);
    resolveDetails?.([
      {
        ...createEmptyDebugLevelRecord(),
        id: '7dl000000000001AAA',
        developerName: 'ALV_STALE',
        masterLabel: 'ALV Stale'
      }
    ]);
    resolveActive?.('ALV_STALE');
    await promise;

    assert.deepEqual(posted, []);
  });

  test('loadSelectedTargetStatus localizes unavailable special targets', async () => {
    const { DebugFlagsPanel } = loadDebugFlagsPanel({
      traceflags: {
        getTraceFlagTargetStatus: async () => ({
          target: { type: 'automatedProcess' },
          targetLabel: 'Automated Process',
          targetAvailable: false,
          isActive: false
        })
      }
    });

    const posted: any[] = [];
    const panelLike = {
      disposed: false,
      statusToken: 0,
      getSelectedAuth: async () => ({ username: 'user@example.com' }),
      post: (message: any) => {
        posted.push(message);
      },
      getTargetUnavailableReason: (DebugFlagsPanel as any).prototype.getTargetUnavailableReason
    };

    await (DebugFlagsPanel as any).prototype.loadSelectedTargetStatus.call(panelLike, {
      type: 'automatedProcess'
    });

    const targetStatusMessage = posted.find(message => message.type === 'debugFlagsTargetStatus');
    assert.ok(targetStatusMessage);
    assert.equal(targetStatusMessage.target.type, 'automatedProcess');
    assert.equal(targetStatusMessage.status.targetAvailable, false);
    assert.match(targetStatusMessage.status.unavailableReason, /Automated Process/);
  });

  test('setSelectedOrg clears the selected target before bootstrapping', async () => {
    const { DebugFlagsPanel } = loadDebugFlagsPanel();
    let bootstrapped = 0;
    const panelLike = {
      selectedOrg: 'old@example.com',
      selectedTarget: { type: 'platformIntegration' },
      bootstrapData: async () => {
        bootstrapped += 1;
      }
    };

    await (DebugFlagsPanel as any).prototype.setSelectedOrg.call(panelLike, 'new@example.com');

    assert.equal(panelLike.selectedOrg, 'new@example.com');
    assert.equal(panelLike.selectedTarget, undefined);
    assert.equal(bootstrapped, 1);
  });

  test('bootstrapData loads orgs and auth through runtime client', async () => {
    const runtimeAuth = {
      username: 'runtime@example.com',
      instanceUrl: 'https://example.com',
      accessToken: 'token'
    };

    const { DebugFlagsPanel } = loadDebugFlagsPanel({
      runtime: {
        runtimeClient: {
          orgList: async () => [
            {
              username: 'runtime@example.com',
              alias: 'Runtime',
              isDefaultUsername: true
            }
          ],
          getOrgAuth: async ({ username }: { username?: string } = {}) => ({
            ...runtimeAuth,
            username: username ?? runtimeAuth.username
          })
        }
      },
      cli: {
        listOrgs: async () => {
          throw new Error('should not call cli listOrgs');
        },
        getOrgAuth: async () => {
          throw new Error('should not call cli getOrgAuth');
        }
      }
    });

    const posted: any[] = [];
    const debugLevelCalls: Array<{ auth: typeof runtimeAuth; token?: number }> = [];
    let searchUsersCalls = 0;
    const panelLike = {
      disposed: false,
      orgBootstrapToken: 0,
      selectedOrg: 'runtime@example.com',
      post: (message: any) => {
        posted.push(message);
      },
      getSelectedAuth: (DebugFlagsPanel as any).prototype.getSelectedAuth,
      sendDebugLevelData: async (auth: typeof runtimeAuth, _selectedId?: string, token?: number) => {
        debugLevelCalls.push({ auth, token });
      },
      searchUsers: async () => {
        searchUsersCalls += 1;
      }
    };

    await (DebugFlagsPanel as any).prototype.bootstrapData.call(panelLike);

    assert.deepEqual(posted.find(message => message.type === 'debugFlagsOrgs'), {
      type: 'debugFlagsOrgs',
      data: [
        {
          username: 'runtime@example.com',
          alias: 'Runtime',
          isDefaultUsername: true
        }
      ],
      selected: 'runtime@example.com'
    });
    assert.deepEqual(debugLevelCalls, [{ auth: runtimeAuth, token: 1 }]);
    assert.equal(searchUsersCalls, 1);
    assert.equal(posted.some(message => message.type === 'debugFlagsError'), false);
  });

  test('searchUsers emits sanitized telemetry on success', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const { DebugFlagsPanel } = loadDebugFlagsPanel({
      telemetry: {
        safeSendEvent: (
          name: string,
          properties?: Record<string, string>,
          measurements?: Record<string, number>
        ) => {
          events.push({ name, properties, measurements });
        }
      },
      traceflags: {
        listActiveUsers: async () => [
          { id: '005000000000001AAA', name: 'Alice', username: 'alice@example.com' },
          { id: '005000000000002AAA', name: 'Bob', username: 'bob@example.com' }
        ]
      }
    });

    const panelLike = {
      disposed: false,
      usersToken: 0,
      usersQuery: 'alice',
      lastSourceView: 'logs',
      selectedTarget: undefined,
      getSelectedAuth: async () => ({ username: 'user@example.com' }),
      post: () => undefined
    };

    await (DebugFlagsPanel as any).prototype.searchUsers.call(panelLike);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, 'debugFlags.searchUsers');
    assert.deepEqual(events[0]?.properties, {
      outcome: 'ok',
      sourceView: 'logs',
      queryLength: '4-10'
    });
    assert.equal(events[0]?.measurements?.count, 2);
    assert.equal(typeof events[0]?.measurements?.durationMs, 'number');
  });

  test('searchUsers emits sanitized telemetry on error', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    const { DebugFlagsPanel } = loadDebugFlagsPanel({
      telemetry: {
        safeSendEvent: (
          name: string,
          properties?: Record<string, string>,
          measurements?: Record<string, number>
        ) => {
          events.push({ name, properties, measurements });
        }
      },
      traceflags: {
        listActiveUsers: async () => {
          throw new Error('boom');
        }
      }
    });

    const panelLike = {
      disposed: false,
      usersToken: 0,
      usersQuery: '',
      lastSourceView: 'tail',
      selectedTarget: undefined,
      getSelectedAuth: async () => ({ username: 'user@example.com' }),
      post: () => undefined
    };

    await (DebugFlagsPanel as any).prototype.searchUsers.call(panelLike);

    assert.equal(events.length, 1);
    assert.equal(events[0]?.name, 'debugFlags.searchUsers');
    assert.deepEqual(events[0]?.properties, {
      outcome: 'error',
      sourceView: 'tail',
      queryLength: '0'
    });
    assert.equal(typeof events[0]?.measurements?.durationMs, 'number');
  });

  test('onMessage ignores malformed apply payloads before invoking actions', async () => {
    const { DebugFlagsPanel } = loadDebugFlagsPanel();
    let applyCalls = 0;
    const panelLike = {
      disposed: false,
      applyTraceFlag: async () => {
        applyCalls += 1;
      }
    };

    await (DebugFlagsPanel as any).prototype.onMessage.call(panelLike, {
      type: 'debugFlagsApply',
      target: { type: 'user' },
      debugLevelName: 'SFDC_DevConsole',
      ttlMinutes: 30
    });

    assert.equal(applyCalls, 0);
  });
});
