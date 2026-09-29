import { test as base } from '@playwright/test';
import { createPoolLease, type PoolLease } from '../utils/poolLease';
import { ensureScratchOrg } from '../utils/scratchOrg';

type Fixtures = {
  poolLease: PoolLease;
  scratchAlias: string;
  _poolLeaseGuard: void;
};

export const test = base.extend<Fixtures>({
  poolLease: async ({}, use) => {
    const poolLease = createPoolLease(ensureScratchOrg);
    try {
      await use(poolLease);
    } finally {
      await poolLease.release();
    }
  },

  _poolLeaseGuard: [
    async ({ poolLease }, use, testInfo) => {
      await use();
      poolLease.recordTestOutcome(testInfo);
    },
    { auto: true }
  ],

  scratchAlias: async ({ poolLease }, use) => {
    await use(await poolLease.acquire());
  }
});
