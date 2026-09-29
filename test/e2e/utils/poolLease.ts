import type { TestInfo } from '@playwright/test';
import type { ScratchOrgResult } from './scratchOrg';

export type PoolLeaseTestOutcome = Pick<TestInfo, 'title' | 'status' | 'expectedStatus'>;

/**
 * Lifecycle of one Pool Lease over the scratch-org provider.
 *
 * The first failure retires the environment: a test whose status differs from its expected status,
 * a failed lease health check, or a failed fixture teardown. Expected failures and runtime skips
 * match their expected status and do not retire it.
 */
export type PoolLease = {
  /** Acquires the Pool Lease on the first request and returns its scratch alias; refuses reuse after a failure. */
  acquire: () => Promise<string>;
  /** Records a test's outcome, then fails it when the lease health check fails. */
  recordTestOutcome: (outcome: PoolLeaseTestOutcome) => void;
  /**
   * Records the test's outcome, then runs a fixture teardown, recording its failure before rethrowing it.
   * Recording the outcome first keeps a teardown failure from masking the test failure that preceded it.
   */
  runTeardown: (outcome: PoolLeaseTestOutcome, teardown: () => Promise<void>) => Promise<void>;
  /** Finalizes the Pool Lease as completed, or as failed and needing recreation with the first failure message. */
  release: () => Promise<void>;
};

export function createPoolLease(provideScratchOrg: () => Promise<ScratchOrgResult>): PoolLease {
  let acquisition: Promise<ScratchOrgResult> | undefined;
  let scratch: ScratchOrgResult | undefined;
  let failureMessage: string | undefined;
  const recordFailure = (error: unknown) => {
    failureMessage ??= error instanceof Error ? error.message : String(error);
  };
  const recordStatusMismatch = ({ title, status, expectedStatus }: PoolLeaseTestOutcome) => {
    if (status !== expectedStatus) {
      recordFailure(`Test '${title}' ended with status '${status}' (expected '${expectedStatus}').`);
    }
  };
  const checkLeaseHealth = (leased: ScratchOrgResult) => {
    try {
      leased.assertLeaseHealthy?.();
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  };

  return {
    acquire: async () => {
      if (failureMessage !== undefined) {
        throw new Error(`Pool Lease cannot be reused after a failure: ${failureMessage}`);
      }
      acquisition ??= provideScratchOrg();
      scratch = await acquisition;
      checkLeaseHealth(scratch);
      return scratch.scratchAlias;
    },
    recordTestOutcome: outcome => {
      recordStatusMismatch(outcome);
      if (scratch) {
        checkLeaseHealth(scratch);
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
      if (!scratch) {
        return;
      }
      const failed = failureMessage !== undefined;
      await scratch.cleanup({
        success: !failed,
        needsRecreate: failed,
        errorMessage: failureMessage,
        lastRunResult: failed ? 'failed' : 'completed'
      });
    }
  };
}
