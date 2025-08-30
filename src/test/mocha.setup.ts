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
    const failIfNone = /^1|true$/i.test(String(process.env.VSCODE_TEST_FAIL_IF_NO_TESTS || ''));
    if (failIfNone && executedCount === 0) {
      throw new Error('No tests executed. Check grep/scope or missing dependencies.');
    }
  }
};
