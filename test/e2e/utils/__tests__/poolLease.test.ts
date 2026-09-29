import { createPoolLease, type PoolLeaseTestOutcome } from '../poolLease';
import type { ScratchOrgCleanupOptions, ScratchOrgResult } from '../scratchOrg';

function fakeScratchOrgProvider() {
  const releases: Array<ScratchOrgCleanupOptions | undefined> = [];
  let healthFailure: Error | undefined;
  const provide = jest.fn(async (): Promise<ScratchOrgResult> => ({
    devHubAlias: 'ALV_DevHub',
    scratchAlias: `ALV_Pool_${provide.mock.calls.length}`,
    created: false,
    strategy: 'pool',
    slotKey: 'slot-01',
    leaseToken: 'lease-token',
    cleanup: async options => {
      releases.push(options);
    },
    assertLeaseHealthy: () => {
      if (healthFailure) {
        throw healthFailure;
      }
    }
  }));
  return {
    provide,
    releases,
    loseLeaseHealth(message: string) {
      healthFailure = new Error(message);
    }
  };
}

const passed = (title = 'passes'): PoolLeaseTestOutcome => ({ title, status: 'passed', expectedStatus: 'passed' });
const timedOut: PoolLeaseTestOutcome = { title: 'opens the log', status: 'timedOut', expectedStatus: 'passed' };

describe('createPoolLease', () => {
  test('takes no Pool Lease when no test requests the org', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    poolLease.recordTestOutcome(passed());
    await poolLease.release();

    expect(provider.provide).not.toHaveBeenCalled();
    expect(provider.releases).toEqual([]);
  });

  test('acquires the Pool Lease the first time a test requests the org', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    expect(provider.provide).not.toHaveBeenCalled();
    await expect(poolLease.acquire()).resolves.toBe('ALV_Pool_1');
    expect(provider.provide).toHaveBeenCalledTimes(1);
  });

  test('has nothing to release when acquisition fails', async () => {
    const provider = fakeScratchOrgProvider();
    provider.provide.mockRejectedValueOnce(new Error('No healthy pool slot became available.'));
    const poolLease = createPoolLease(provider.provide);

    await expect(poolLease.acquire()).rejects.toThrow('No healthy pool slot became available.');
    await expect(poolLease.release()).resolves.toBeUndefined();
  });

  test('returns the same Pool Lease for repeated requests', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    const concurrent = await Promise.all([poolLease.acquire(), poolLease.acquire()]);
    poolLease.recordTestOutcome(passed('first'));
    const later = await poolLease.acquire();

    expect(concurrent).toEqual(['ALV_Pool_1', 'ALV_Pool_1']);
    expect(later).toBe('ALV_Pool_1');
    expect(provider.provide).toHaveBeenCalledTimes(1);
  });

  test('releases the Pool Lease as completed and healthy when no failure was recorded', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    poolLease.recordTestOutcome(passed());
    await poolLease.release();

    expect(provider.releases).toEqual([
      { success: true, needsRecreate: false, errorMessage: undefined, lastRunResult: 'completed' }
    ]);
  });

  test('retires the environment when a test status differs from its expected status', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    poolLease.recordTestOutcome(timedOut);
    await poolLease.release();

    expect(provider.releases).toEqual([
      {
        success: false,
        needsRecreate: true,
        errorMessage: "Test 'opens the log' ended with status 'timedOut' (expected 'passed').",
        lastRunResult: 'failed'
      }
    ]);
  });

  test('retires the environment when a fixture teardown fails after a passing test', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);
    const teardownError = new Error('VS Code did not exit');

    await poolLease.acquire();
    await expect(
      poolLease.runTeardown(passed(), async () => {
        throw teardownError;
      })
    ).rejects.toBe(teardownError);
    poolLease.recordTestOutcome(passed());
    await poolLease.release();

    expect(provider.releases).toEqual([
      { success: false, needsRecreate: true, errorMessage: 'VS Code did not exit', lastRunResult: 'failed' }
    ]);
  });

  test.each<[string, PoolLeaseTestOutcome]>([
    ['a test expected to fail that fails', { title: 'known bug', status: 'failed', expectedStatus: 'failed' }],
    ['a runtime skip', { title: 'needs replay debugger', status: 'skipped', expectedStatus: 'skipped' }]
  ])('does not retire the environment after %s', async (_label, outcome) => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    poolLease.recordTestOutcome(outcome);
    await poolLease.release();

    expect(provider.releases).toEqual([
      { success: true, needsRecreate: false, errorMessage: undefined, lastRunResult: 'completed' }
    ]);
  });

  test('fails the test and retires the environment when the lease health check fails after it', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    provider.loseLeaseHealth('Scratch-org pool heartbeat lost the lease.');
    expect(() => poolLease.recordTestOutcome(passed())).toThrow('Scratch-org pool heartbeat lost the lease.');
    await poolLease.release();

    expect(provider.releases).toEqual([
      {
        success: false,
        needsRecreate: true,
        errorMessage: 'Scratch-org pool heartbeat lost the lease.',
        lastRunResult: 'failed'
      }
    ]);
  });

  test('refuses reuse after a recorded failure', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    poolLease.recordTestOutcome({ title: 'opens the log', status: 'failed', expectedStatus: 'passed' });

    await expect(poolLease.acquire()).rejects.toThrow(
      "Test 'opens the log' ended with status 'failed' (expected 'passed')."
    );
    expect(provider.provide).toHaveBeenCalledTimes(1);
  });

  test('reports the test failure rather than a teardown failure that follows it', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await expect(
      poolLease.runTeardown(timedOut, async () => {
        throw new Error('Could not redact the preserved VS Code user data.');
      })
    ).rejects.toThrow();
    poolLease.recordTestOutcome(timedOut);
    await poolLease.release();

    expect(provider.releases).toEqual([
      expect.objectContaining({
        needsRecreate: true,
        errorMessage: "Test 'opens the log' ended with status 'timedOut' (expected 'passed')."
      })
    ]);
  });

  test('reports the teardown failure rather than a lease health failure that follows it', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await expect(
      poolLease.runTeardown(passed(), async () => {
        throw new Error('VS Code did not exit');
      })
    ).rejects.toThrow();
    provider.loseLeaseHealth('Scratch-org pool heartbeat lost the lease.');
    expect(() => poolLease.recordTestOutcome(passed())).toThrow();
    await poolLease.release();

    expect(provider.releases).toEqual([
      expect.objectContaining({ needsRecreate: true, errorMessage: 'VS Code did not exit' })
    ]);
  });

  test('refuses to hand out a Pool Lease whose health check fails', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    provider.loseLeaseHealth('Scratch-org pool heartbeat lost the lease.');
    await expect(poolLease.acquire()).rejects.toThrow('Scratch-org pool heartbeat lost the lease.');
    await poolLease.release();

    expect(provider.releases).toEqual([
      expect.objectContaining({ needsRecreate: true, errorMessage: 'Scratch-org pool heartbeat lost the lease.' })
    ]);
  });
});
