import assert from 'assert/strict';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import * as traceflags from '../salesforce/traceflags';
import { createEmptyDebugLevelRecord } from '../shared/debugLevelPresets';

suite('DebugFlagsPanel', () => {
  const originalListDebugLevelDetails = traceflags.listDebugLevelDetails;
  const originalGetActiveUserDebugLevel = traceflags.getActiveUserDebugLevel;

  teardown(() => {
    (traceflags as any).listDebugLevelDetails = originalListDebugLevelDetails;
    (traceflags as any).getActiveUserDebugLevel = originalGetActiveUserDebugLevel;
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
});
