function installMinimalDomShims(): void {
  class HTMLElementMock {}

  const document = {
    body: {
      appendChild() {},
      removeChild() {}
    },
    documentElement: {},
    createElement: () => ({
      style: {},
      appendChild() {},
      removeChild() {},
      remove() {},
      setAttribute() {},
      getAttribute() {
        return null;
      }
    })
  };

  const navigator = { userAgent: 'node' };
  const window = {
    document,
    navigator,
    HTMLElement: HTMLElementMock,
    getComputedStyle: () => ({
      getPropertyValue: () => ''
    })
  };

  (globalThis as any).window = window;
  (globalThis as any).document = document;
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true });
  (globalThis as any).HTMLElement = HTMLElementMock;
  (globalThis as any).getComputedStyle = window.getComputedStyle;
}

function shouldFallbackToMinimalDom(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return (
    (code === 'ERR_REQUIRE_ESM' || /ERR_REQUIRE_ESM/.test(message)) &&
    (/html-encoding-sniffer/.test(message) || /@exodus\/bytes/.test(message) || /jsdom/.test(message))
  );
}

function installDomEnvironment(): void {
  try {
    // VS Code 1.90 ships an extension host Node runtime that cannot require the
    // ESM-only transitive dependency pulled by newer jsdom releases.
    const { JSDOM } = require('jsdom') as typeof import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).getComputedStyle = dom.window.getComputedStyle;
    return;
  } catch (error) {
    if (!shouldFallbackToMinimalDom(error)) {
      throw error;
    }
    console.warn('[mocha.setup] jsdom unavailable in this VS Code host; using minimal DOM shims instead.');
    installMinimalDomShims();
  }
}

installDomEnvironment();
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverMock;

// Log test start/finish to help diagnose failures in the VS Code host
let executedCount = 0;

if (process.env.ENABLE_COVERAGE) {
  console.log('[coverage] ENABLE_COVERAGE detected. NODE_V8_COVERAGE=', process.env.NODE_V8_COVERAGE ?? '<undefined>');
}

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
