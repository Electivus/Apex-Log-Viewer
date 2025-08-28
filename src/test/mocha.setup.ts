// Log test start/finish to help diagnose failures in the VS Code host
export const mochaHooks = {
  beforeEach(this: any) {
    const name = this.currentTest?.fullTitle?.() ?? 'unknown';
     
    console.log(`[mocha] starting: ${name}`);
  },
  afterEach(this: any) {
    const name = this.currentTest?.fullTitle?.() ?? 'unknown';
    const state = this.currentTest?.state ?? 'unknown';
     
    console.log(`[mocha] finished: ${name} -> ${state}`);
  }
};
