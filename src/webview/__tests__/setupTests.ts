import '@testing-library/jest-dom';

// Ensure React Testing Library acts warnings surface during async updates
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
}

if (typeof globalThis.cancelAnimationFrame !== 'function') {
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
}

if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverMock;
}
