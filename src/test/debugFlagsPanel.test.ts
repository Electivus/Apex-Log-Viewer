import assert from 'assert/strict';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import * as traceflags from '../salesforce/traceflags';
import * as telemetry from '../shared/telemetry';
import { createEmptyDebugLevelRecord } from '../shared/debugLevelPresets';

suite('DebugFlagsPanel', () => {
  const originalListDebugLevelDetails = traceflags.listDebugLevelDetails;
  const originalGetActiveUserDebugLevel = traceflags.getActiveUserDebugLevel;
  const originalGetTraceFlagTargetStatus = traceflags.getTraceFlagTargetStatus;
  const originalListActiveUsers = traceflags.listActiveUsers;
  const originalSafeSendEvent = telemetry.safeSendEvent;

  teardown(() => {
    (traceflags as any).listDebugLevelDetails = originalListDebugLevelDetails;
    (traceflags as any).getActiveUserDebugLevel = originalGetActiveUserDebugLevel;
    (traceflags as any).getTraceFlagTargetStatus = originalGetTraceFlagTargetStatus;
    (traceflags as any).listActiveUsers = originalListActiveUsers;
    (telemetry as any).safeSendEvent = originalSafeSendEvent;
  });

  test('sendDebugLevelData ignores stale bootstrap results', async () => {
    let resolveDetails: ((value: ReturnType<typeof createEmptyDebugLevelRecord>[]) => void) | undefined;
    let resolveActive: ((value: string | undefined) => void) | undefined;

    (traceflags as any).listDebugLevelDetails = async () =>
      await new Promise(resolve => {
        resolveDetails = resolve;
      });
    (traceflags as any).getActiveUserDebugLevel = async () =>
      await new Promise(resolve => {
        resolveActive = resolve;
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
    (traceflags as any).getTraceFlagTargetStatus = async () => ({
      target: { type: 'automatedProcess' },
      targetLabel: 'Automated Process',
      targetAvailable: false,
      isActive: false
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

  test('searchUsers emits sanitized telemetry on success', async () => {
    const events: Array<{ name: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
    (telemetry as any).safeSendEvent = (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
      events.push({ name, properties, measurements });
    };
    (traceflags as any).listActiveUsers = async () => [
      { id: '005000000000001AAA', name: 'Alice', username: 'alice@example.com' },
      { id: '005000000000002AAA', name: 'Bob', username: 'bob@example.com' }
    ];

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
    (telemetry as any).safeSendEvent = (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
      events.push({ name, properties, measurements });
    };
    (traceflags as any).listActiveUsers = async () => {
      throw new Error('boom');
    };

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
});
