import { test as base } from '@playwright/test';
import { createPoolLease, type PoolLease } from '../utils/poolLease';
import { ensureScratchOrg } from '../utils/scratchOrg';

type TestFixtures = {
  scratchAlias: string;
  _poolLeaseGuard: void;
};

type WorkerFixtures = {
  poolLease: PoolLease;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // One Pool Lease per test runner: Playwright discards the worker after a failure, and the lifecycle
  // refuses reuse once a failure is recorded, so the first failure ends the lease.
  poolLease: [
    async ({}, use) => {
      const poolLease = createPoolLease(ensureScratchOrg);
      try {
        await use(poolLease);
      } finally {
        await poolLease.release();
      }
    },
    { scope: 'worker' }
  ],

  _poolLeaseGuard: [
    async ({ poolLease }, use, testInfo) => {
      await use();
      await poolLease.finishTest(testInfo);
    },
    { auto: true }
  ],

  scratchAlias: async ({ poolLease }, use) => {
    await use(await poolLease.acquire());
  }
});
