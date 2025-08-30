// Log test start/finish to help diagnose failures in the VS Code host
let executedCount = 0;

export const mochaHooks = {
  beforeEach(this: any) {
    const name = this.currentTest?.fullTitle?.() ?? 'unknown';
    console.log(`[mocha] starting: ${name}`);
  },
  afterEach(this: any) {
    const name = this.currentTest?.fullTitle?.() ?? 'unknown';
    const state = this.currentTest?.state ?? 'unknown';
    // Count only tests that actually executed (passed/failed), not pending/skipped
    if (state === 'passed' || state === 'failed') {
      executedCount++;
    }
    console.log(`[mocha] finished: ${name} -> ${state}`);
  },
  afterAll() {
    if (executedCount === 0) {
      throw new Error('No tests executed. Check scope or missing dependencies.');
    }
  }
};
