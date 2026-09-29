import type { TestInfo } from '@playwright/test';
import type { ScratchOrgResult } from './scratchOrg';

export type PoolLeaseTestOutcome = Pick<TestInfo, 'title' | 'status' | 'expectedStatus'>;

/**
 * Lifecycle of the Pool Lease a test runner holds across its consecutive tests, over the scratch-org provider.
 *
 * The first failure ends the Pool Lease and retires the environment: a test whose status differs from its
 * expected status, a failed lease health check, or a failed fixture teardown. The runner's next org request
 * takes a new Pool Lease. Expected failures and runtime skips match their expected status and keep the
 * Pool Lease; tests that never request the org cannot retire the environment.
 */
export type PoolLease = {
  /** Acquires a Pool Lease on the first request and returns its scratch alias; refuses reuse once a failure is recorded. */
  acquire: () => Promise<string>;
  /**
   * Finishes the current test. When it requested the org, records its outcome and checks lease health; after a
   * failure, ends the Pool Lease as failed and needing recreation, and fails the test if the lease was unhealthy.
   */
  finishTest: (outcome: PoolLeaseTestOutcome) => Promise<void>;
  /**
   * Records the test's outcome, then runs a fixture teardown, recording its failure before rethrowing it.
   * Recording the outcome first keeps a teardown failure from masking the test failure that preceded it.
   */
  runTeardown: (outcome: PoolLeaseTestOutcome, teardown: () => Promise<void>) => Promise<void>;
  /**
   * Ends the runner's Pool Lease after a last health check: as completed, or as failed and needing recreation
   * with the first failure message.
   */
  release: () => Promise<void>;
};

export function createPoolLease(provideScratchOrg: () => Promise<ScratchOrgResult>): PoolLease {
  let acquisition: Promise<ScratchOrgResult> | undefined;
  let scratch: ScratchOrgResult | undefined;
  let failureMessage: string | undefined;
  let currentTestRequestedOrg = false;
  const recordFailure = (error: unknown) => {
    failureMessage ??= error instanceof Error ? error.message : String(error);
  };
  const recordStatusMismatch = ({ title, status, expectedStatus }: PoolLeaseTestOutcome) => {
    if (status !== expectedStatus) {
      recordFailure(`Test '${title}' ended with status '${status}' (expected '${expectedStatus}').`);
    }
  };
  /** Returns the lease health failure, if any, after recording it. */
  const recordLeaseHealth = (leased: ScratchOrgResult): unknown => {
    try {
      leased.assertLeaseHealthy?.();
      return undefined;
    } catch (error) {
      recordFailure(error);
      return error;
    }
  };
  const endLease = async () => {
    const leased = scratch;
    const endingFailure = failureMessage;
    acquisition = undefined;
    scratch = undefined;
    failureMessage = undefined;
    if (!leased) {
      return;
    }
    const failed = endingFailure !== undefined;
    await leased.cleanup({
      success: !failed,
      needsRecreate: failed,
      errorMessage: endingFailure,
      lastRunResult: failed ? 'failed' : 'completed'
    });
  };

  return {
    acquire: async () => {
      currentTestRequestedOrg = true;
      if (failureMessage !== undefined) {
        throw new Error(`Pool Lease cannot be reused after a failure: ${failureMessage}`);
      }
      acquisition ??= provideScratchOrg();
      try {
        scratch = await acquisition;
      } catch (error) {
        recordFailure(error);
        throw error;
      }
      const healthFailure = recordLeaseHealth(scratch);
      if (healthFailure) {
        throw healthFailure;
      }
      return scratch.scratchAlias;
    },
    finishTest: async outcome => {
      if (!currentTestRequestedOrg) {
        return;
      }
      currentTestRequestedOrg = false;
      recordStatusMismatch(outcome);
      const healthFailure = scratch ? recordLeaseHealth(scratch) : undefined;
      if (failureMessage !== undefined) {
        await endLease();
      }
      if (healthFailure) {
        throw healthFailure;
      }
    },
    runTeardown: async (outcome, teardown) => {
      recordStatusMismatch(outcome);
      try {
        await teardown();
      } catch (error) {
        recordFailure(error);
        throw error;
      }
    },
    release: async () => {
      if (scratch) {
        recordLeaseHealth(scratch);
      }
      await endLease();
    }
  };
}
