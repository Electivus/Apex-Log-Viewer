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
const completedRelease: ScratchOrgCleanupOptions = {
  success: true,
  needsRecreate: false,
  errorMessage: undefined,
  lastRunResult: 'completed'
};

describe('createPoolLease', () => {
  test('takes no Pool Lease when no test requests the org', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.finishTest(passed());
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
    await poolLease.finishTest(passed('first'));
    const later = await poolLease.acquire();

    expect(concurrent).toEqual(['ALV_Pool_1', 'ALV_Pool_1']);
    expect(later).toBe('ALV_Pool_1');
    expect(provider.provide).toHaveBeenCalledTimes(1);
  });

  test('releases the Pool Lease as completed and healthy when no failure was recorded', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await poolLease.finishTest(passed());
    await poolLease.release();

    expect(provider.releases).toEqual([completedRelease]);
  });

  test('retires the environment when a test status differs from its expected status', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await poolLease.finishTest(timedOut);
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
    await poolLease.finishTest(passed());
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
    await poolLease.finishTest(outcome);
    await poolLease.release();

    expect(provider.releases).toEqual([completedRelease]);
  });

  test('fails the test and retires the environment when the lease health check fails after it', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    provider.loseLeaseHealth('Scratch-org pool heartbeat lost the lease.');
    await expect(poolLease.finishTest(passed())).rejects.toThrow('Scratch-org pool heartbeat lost the lease.');
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

  test('refuses reuse of the Pool Lease once a failure is recorded', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await expect(
      poolLease.runTeardown(passed(), async () => {
        throw new Error('VS Code did not exit');
      })
    ).rejects.toThrow();

    await expect(poolLease.acquire()).rejects.toThrow(
      'Pool Lease cannot be reused after a failure: VS Code did not exit'
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
    await poolLease.finishTest(timedOut);
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
    await expect(poolLease.finishTest(passed())).rejects.toThrow();
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

describe('createPoolLease across one test runner', () => {
  test('reuses one Pool Lease across consecutive tests and releases it once as completed', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);
    const consecutiveTests: PoolLeaseTestOutcome[] = [
      passed('opens the log'),
      { title: 'known bug', status: 'failed', expectedStatus: 'failed' },
      { title: 'needs replay debugger', status: 'skipped', expectedStatus: 'skipped' },
      passed('filters errors')
    ];

    const aliases: string[] = [];
    for (const outcome of consecutiveTests) {
      aliases.push(await poolLease.acquire());
      await poolLease.runTeardown(outcome, async () => {});
      await poolLease.finishTest(outcome);
    }
    await poolLease.release();

    expect(aliases).toEqual(['ALV_Pool_1', 'ALV_Pool_1', 'ALV_Pool_1', 'ALV_Pool_1']);
    expect(provider.provide).toHaveBeenCalledTimes(1);
    expect(provider.releases).toEqual([completedRelease]);
  });

  test('ends the Pool Lease when a test with a failure finishes, so the next test takes a new one', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);
    const knownBug: PoolLeaseTestOutcome = { title: 'known bug', status: 'failed', expectedStatus: 'failed' };

    await poolLease.acquire();
    await poolLease.finishTest(passed('opens the log'));
    await poolLease.acquire();
    await expect(
      poolLease.runTeardown(knownBug, async () => {
        throw new Error('VS Code did not exit');
      })
    ).rejects.toThrow();
    await poolLease.finishTest(knownBug);

    expect(provider.releases).toEqual([
      { success: false, needsRecreate: true, errorMessage: 'VS Code did not exit', lastRunResult: 'failed' }
    ]);

    await expect(poolLease.acquire()).resolves.toBe('ALV_Pool_2');
    await poolLease.finishTest(passed('filters errors'));
    await poolLease.release();

    expect(provider.provide).toHaveBeenCalledTimes(2);
    expect(provider.releases).toEqual([
      { success: false, needsRecreate: true, errorMessage: 'VS Code did not exit', lastRunResult: 'failed' },
      completedRelease
    ]);
  });

  test('retries acquisition in the next test after it failed in a test expected to fail', async () => {
    const provider = fakeScratchOrgProvider();
    provider.provide.mockRejectedValueOnce(new Error('No healthy pool slot became available.'));
    const poolLease = createPoolLease(provider.provide);

    await expect(poolLease.acquire()).rejects.toThrow('No healthy pool slot became available.');
    await poolLease.finishTest({ title: 'known bug', status: 'failed', expectedStatus: 'failed' });

    await expect(poolLease.acquire()).resolves.toBe('ALV_Pool_2');
    expect(provider.provide).toHaveBeenCalledTimes(2);
  });

  test('ignores the outcome of a later test that never requested the org', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await poolLease.finishTest(passed('uses the org'));
    await poolLease.finishTest({ title: 'checks settings only', status: 'failed', expectedStatus: 'passed' });
    await poolLease.release();

    expect(provider.releases).toEqual([completedRelease]);
  });

  test('skips the health check for a test that never requested the org and retires the environment at release', async () => {
    const provider = fakeScratchOrgProvider();
    const poolLease = createPoolLease(provider.provide);

    await poolLease.acquire();
    await poolLease.finishTest(passed('uses the org'));
    provider.loseLeaseHealth('Scratch-org pool heartbeat lost the lease.');
    await expect(poolLease.finishTest(passed('checks settings only'))).resolves.toBeUndefined();
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
});
