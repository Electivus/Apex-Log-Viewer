import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { WebviewToExtensionMessage } from '@alv/protocol/messages';
import { TailApp } from '../tail';
import type { VsCodeWebviewApi } from '../vscodeApi';

/** Row heights the virtual list reads. A full read of the buffer is one rebuild of its row position cache. */
let rowHeightReads = 0;

jest.mock('react-window', () => {
  const React = require('react');
  const actual = jest.requireActual('react-window');
  const counted = new WeakMap<object, unknown>();
  const counting = (rowHeight: any) => {
    if (typeof rowHeight === 'function') {
      return (index: number, props: unknown) => {
        rowHeightReads++;
        return rowHeight(index, props);
      };
    }
    if (typeof rowHeight === 'object') {
      return {
        ...rowHeight,
        getRowHeight: (index: number) => {
          rowHeightReads++;
          return rowHeight.getRowHeight(index);
        }
      };
    }
    return rowHeight;
  };
  // Keeps the identity of the height source the List is given, so the wrapper itself causes no rebuild.
  function CountingList(props: any) {
    const { rowHeight } = props;
    if (typeof rowHeight !== 'object' && typeof rowHeight !== 'function') {
      return React.createElement(actual.List, props);
    }
    if (!counted.has(rowHeight)) {
      counted.set(rowHeight, counting(rowHeight));
    }
    return React.createElement(actual.List, { ...props, rowHeight: counted.get(rowHeight) });
  }
  return { ...actual, List: CountingList };
});

/**
 * TailApp with the real react-window List over a fake browser layout. Every line is ROW pixels tall, the list shows
 * VIEWPORT pixels, a scroll offset is clamped to the content, and a ResizeObserver and a scroll event arrive on the
 * next frame, as in a browser.
 */
const ROW = 32;
const VIEWPORT = 200;

const isList = (element: HTMLElement) => element.getAttribute('role') === 'list';
const isRow = (element: Element) => element.closest('[role="row"]') !== null;
const ownHeight = (element: HTMLElement) => (isRow(element) ? ROW : VIEWPORT);
const laidOutHeight = (element: HTMLElement) => parseFloat(element.style.height) || ownHeight(element);

function contentHeight(list: HTMLElement) {
  const bottoms = Array.from(list.children as HTMLCollectionOf<HTMLElement>).map(
    child => (parseFloat(child.style.transform.replace('translateY(', '')) || 0) + laidOutHeight(child)
  );
  return Math.max(VIEWPORT, ...bottoms);
}

const scrollTops = new WeakMap<HTMLElement, number>();
const pendingScrollEvents = new Set<HTMLElement>();

function clampScroll(element: HTMLElement, top: number) {
  return Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, top));
}

function scrolled(element: HTMLElement) {
  if (pendingScrollEvents.has(element)) {
    return;
  }
  pendingScrollEvents.add(element);
  requestAnimationFrame(() => {
    pendingScrollEvents.delete(element);
    element.dispatchEvent(new Event('scroll'));
  });
}

class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
    requestAnimationFrame(() => {
      if (!this.targets.has(target)) {
        return;
      }
      const height = isRow(target) ? ROW : VIEWPORT;
      const entry = {
        target,
        contentRect: { height, width: 800 },
        borderBoxSize: [{ blockSize: height, inlineSize: 800 }]
      } as unknown as ResizeObserverEntry;
      this.callback([entry], this as unknown as ResizeObserver);
    });
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }
}

const layout: PropertyDescriptorMap = {
  clientHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return ownHeight(this);
    }
  },
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return laidOutHeight(this);
    }
  },
  scrollHeight: {
    configurable: true,
    get(this: HTMLElement) {
      if (isList(this)) {
        return contentHeight(this);
      }
      // What a browser reads for a row's content: the row without its 1 px bottom border.
      return isRow(this) ? ROW - 1 : VIEWPORT;
    }
  },
  scrollTop: {
    configurable: true,
    get(this: HTMLElement) {
      const current = scrollTops.get(this) ?? 0;
      const clamped = clampScroll(this, current);
      if (clamped !== current) {
        scrollTops.set(this, clamped);
        scrolled(this);
      }
      return clamped;
    },
    set(this: HTMLElement, top: number) {
      const clamped = clampScroll(this, top);
      if (clamped !== (scrollTops.get(this) ?? 0)) {
        scrollTops.set(this, clamped);
        scrolled(this);
      }
    }
  },
  scrollTo: {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    }
  }
};

const list = () => screen.getByRole('list');
const distanceFromEnd = () => list().scrollHeight - list().clientHeight - list().scrollTop;
const autoScroll = () => screen.getByRole('switch', { name: 'Auto-scroll' });

function frames(count: number) {
  for (let frame = 0; frame < count; frame++) {
    act(() => {
      jest.advanceTimersByTime(16);
    });
  }
}

function openTail({ autoScroll: follow, bufferSize }: { autoScroll: boolean; bufferSize?: number }) {
  const bus = new EventTarget();
  const vscode: VsCodeWebviewApi<WebviewToExtensionMessage> = {
    postMessage: () => {},
    getState: () => ({ autoScroll: follow }) as any,
    setState: () => {}
  };
  render(<TailApp vscode={vscode} messageBus={bus} />);
  if (bufferSize !== undefined) {
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: { type: 'tailConfig', tailBufferSize: bufferSize } }));
    });
  }
  const receive = (firstSeq: number, count: number) =>
    act(() => {
      const lines = Array.from({ length: count }, (_, i) => `Line ${firstSeq + i}`);
      const data = { type: firstSeq === 0 ? 'tailSnapshot' : 'tailData', streamId: 'test-stream', firstSeq, lines };
      bus.dispatchEvent(new MessageEvent('message', { data }));
    });
  receive(0, bufferSize ?? 40);
  frames(18);
  return receive;
}

describe('Tail Auto-scroll over the real virtual list', () => {
  const descriptors = Object.keys(layout).map(
    name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
  );
  const NoResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    pendingScrollEvents.clear();
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    Object.defineProperties(HTMLElement.prototype, layout);
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.ResizeObserver = NoResizeObserver;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    }
  });

  // Regression test for b9397f86, fixed in b2a99d27: it fails there and passes on main, which never had the bug.
  it('stays at the end when Auto-scroll is turned on while the list still reveals the selected line', () => {
    const receive = openTail({ autoScroll: false });
    fireEvent.click(screen.getByText('Line 1'));
    frames(30);
    // A new batch makes the list reveal the selected line again, over the next frames.
    receive(40, 1);
    frames(1);

    fireEvent.click(autoScroll());
    frames(10);

    expect(distanceFromEnd()).toBe(0);
    expect(autoScroll()).toBeChecked();
  });

  // Parity control: passes on main and on every commit of this change.
  it('follows the end while measured batches arrive', () => {
    const receive = openTail({ autoScroll: true });
    expect(distanceFromEnd()).toBe(0);

    receive(40, 20);
    frames(14);

    expect(distanceFromEnd()).toBe(0);
    expect(autoScroll()).toBeChecked();
  });

  it('reads each row height once per new line while a full buffer follows the end', () => {
    const BUFFER = 1000;
    const receive = openTail({ autoScroll: true, bufferSize: BUFFER });
    expect(distanceFromEnd()).toBe(0);

    const readsPerLine: number[] = [];
    for (let line = BUFFER; line < BUFFER + 3; line++) {
      rowHeightReads = 0;
      receive(line, 1);
      frames(20);
      readsPerLine.push(rowHeightReads);
    }

    expect(distanceFromEnd()).toBe(0);
    for (const reads of readsPerLine) {
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(BUFFER);
    }
  });
});
