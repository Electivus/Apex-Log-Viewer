require('@testing-library/jest-dom');

// Ensure React Testing Library act warnings surface during async updates.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

  globalThis.ResizeObserver = ResizeObserverMock;
}

if (typeof globalThis.PointerEvent !== 'function') {
  class PointerEventMock extends MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = typeof params.pointerId === 'number' ? params.pointerId : 0;
    }
  }

  globalThis.PointerEvent = PointerEventMock;
}
