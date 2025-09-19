import { JSDOM } from 'jsdom';

// Basic jsdom environment for React component tests
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).Document = dom.window.Document;
(globalThis as any).DocumentFragment = dom.window.DocumentFragment;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Text = dom.window.Text;
if (!(globalThis as any).PointerEvent) {
  class PointerEvent extends dom.window.MouseEvent {
    constructor(type: string, props?: any) {
      super(type, props);
      Object.assign(this, props);
    }
  }
  (globalThis as any).PointerEvent = PointerEvent;
}
(globalThis as any).getComputedStyle = dom.window.getComputedStyle;
if ((globalThis as any).Element && !(globalThis as any).Element.prototype.hasPointerCapture) {
  (globalThis as any).Element.prototype.hasPointerCapture = () => false;
  (globalThis as any).Element.prototype.setPointerCapture = () => {};
  (globalThis as any).Element.prototype.releasePointerCapture = () => {};
}

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
