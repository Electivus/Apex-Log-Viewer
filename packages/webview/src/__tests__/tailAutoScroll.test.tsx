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
 * TailApp with the real react-window List over a fake browser layout. A line is ROW pixels tall, or TALL_ROW when its
 * text says TALL, the list shows VIEWPORT pixels, a scroll offset is clamped to the content, and a ResizeObserver and
 * a scroll event arrive on the next frame, as in a browser.
 */
const ROW = 32;
const TALL_ROW = 3 * ROW;
const VIEWPORT = 200;

const isList = (element: HTMLElement) => element.getAttribute('role') === 'list';
const rowOf = (element: Element) => element.closest('[role="row"]');
const isRow = (element: Element) => rowOf(element) !== null;
const rowHeightOf = (element: Element) => (rowOf(element)?.textContent?.includes('TALL') ? TALL_ROW : ROW);
const ownHeight = (element: HTMLElement) => (isRow(element) ? rowHeightOf(element) : VIEWPORT);
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

/** The height each line was last measured at, by line sequence number. */
const measuredHeights = new Map<number, number>();

class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
    requestAnimationFrame(() => {
      if (!this.targets.has(target)) {
        return;
      }
      const height = isRow(target) ? rowHeightOf(target) : VIEWPORT;
      const seq = Number(target.getAttribute('data-line-seq') ?? Number.NaN);
      if (Number.isInteger(seq)) {
        measuredHeights.set(seq, height);
      }
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
      return isRow(this) ? rowHeightOf(this) - 1 : VIEWPORT;
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

function openTail({
  autoScroll: follow,
  bufferSize,
  text = seq => `Line ${seq}`
}: {
  autoScroll: boolean;
  bufferSize?: number;
  text?: (seq: number) => string;
}) {
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
  const receive = (first: number, count: number) =>
    act(() => {
      const lines = Array.from({ length: count }, (_, i) => text(first + i));
      bus.dispatchEvent(new MessageEvent('message', { data: { type: 'tailData', lines } }));
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
    measuredHeights.clear();
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

  /** Streams `count` lines into a full buffer that follows the end, and returns the row heights read per line. */
  function readsPerNewLine(receive: ReturnType<typeof openTail>, first: number, count: number) {
    const readsPerLine: number[] = [];
    for (let line = first; line < first + count; line++) {
      rowHeightReads = 0;
      receive(line, 1);
      frames(20);
      readsPerLine.push(rowHeightReads);
    }
    return readsPerLine;
  }

  it('reads each row height once per new line as tall as the lines just before it', () => {
    // Lines 0-599 are short and lines from 600 on are tall. The first 120 short lines get measured, then the view
    // follows the end, where it measures a few tall ones, so most measured lines are short.
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: false,
      bufferSize: BUFFER,
      text: seq => (seq >= 600 ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    for (let top = 0; top <= 120 * ROW; top += VIEWPORT / 2) {
      act(() => {
        list().scrollTop = top;
      });
      frames(3);
    }
    fireEvent.click(autoScroll());
    frames(20);
    expect(distanceFromEnd()).toBe(0);

    const readsPerLine = readsPerNewLine(receive, BUFFER, 5);

    expect(distanceFromEnd()).toBe(0);
    expect(readsPerLine).toEqual(readsPerLine.map(() => BUFFER));
  });

  it('reads each row height once per new line when every other line is tall', () => {
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (seq % 2 ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    expect(distanceFromEnd()).toBe(0);
    // The first new lines get the rows at the end measured, until the newest measured rows show the pattern.
    readsPerNewLine(receive, BUFFER, 4);

    const readsPerLine = readsPerNewLine(receive, BUFFER + 4, 6);

    expect(distanceFromEnd()).toBe(0);
    expect(readsPerLine).toEqual(readsPerLine.map(() => BUFFER));
  });

  it('reads each row height once per new line when two tall lines and three short ones repeat', () => {
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (seq % 5 < 2 ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    readsPerNewLine(receive, BUFFER, 10);

    const readsPerLine = readsPerNewLine(receive, BUFFER + 10, 10);

    expect(distanceFromEnd()).toBe(0);
    expect(readsPerLine).toEqual(readsPerLine.map(() => BUFFER));
  });

  it('reads each row height no more often than the most common height asks for when tall lines come in bursts', () => {
    // Six tall lines every 40. The newest lines follow no short pattern across a burst, so a new line counts the
    // buffer's common height, the short one: a short line costs one pass and a tall one two, never more.
    const BUFFER = 1000;
    const isTall = (seq: number) => seq % 40 < 6;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (isTall(seq) ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    readsPerNewLine(receive, BUFFER, 12);

    const first = BUFFER + 12;
    const readsPerLine = readsPerNewLine(receive, first, 80);

    expect(distanceFromEnd()).toBe(0);
    expect(readsPerLine).toEqual(readsPerLine.map((_, k) => (isTall(first + k) ? 2 * BUFFER : BUFFER)));
  });

  /** The measured heights of the buffer's lines, from `first` on, and their mean, rounded. */
  function measuredFrom(first: number) {
    const sizes = [...measuredHeights].filter(([seq]) => seq >= first).map(([, size]) => size);
    return Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  }

  it('counts the mean measured height for the lines not measured yet once Auto-scroll is turned off', () => {
    // Lines 0-89 and 750-999 are tall, the others short, and the end is in view, so the measured lines are tall. Short
    // lines then arrive one by one, and the view pauses as soon as most measured lines are short.
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (seq < 90 || (seq >= 750 && seq < BUFFER) ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    let next = BUFFER;
    const measuredShort = () => [...measuredHeights].filter(([seq, height]) => seq >= next - BUFFER && height === ROW);
    const measuredTall = () =>
      [...measuredHeights].filter(([seq, height]) => seq >= next - BUFFER && height === TALL_ROW);
    while (measuredShort().length <= measuredTall().length) {
      readsPerNewLine(receive, next, 1);
      next++;
    }

    const mean = measuredFrom(next - BUFFER);
    fireEvent.click(autoScroll());
    frames(20);

    let expected = 0;
    for (let seq = next - BUFFER; seq < next; seq++) {
      expected += measuredHeights.get(seq) ?? mean;
    }
    expect(autoScroll()).not.toBeChecked();
    expect(list().scrollHeight).toBe(expected);
  });

  it('keeps the heights it predicted for lines not measured yet once Auto-scroll is turned off', () => {
    // Most measured lines are short and the newest ones tall, so a batch of tall lines arrives at the tall height,
    // and only the rows at the end get measured. Turning Auto-scroll off must not give the others another height:
    // only the lines with neither a measurement nor a prediction take the mean measured height.
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: false,
      bufferSize: BUFFER,
      text: seq => (seq >= 600 ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    for (let top = 0; top <= 300 * ROW; top += VIEWPORT / 2) {
      act(() => {
        list().scrollTop = top;
      });
      frames(3);
    }
    fireEvent.click(autoScroll());
    frames(20);
    readsPerNewLine(receive, BUFFER, 5);
    receive(BUFFER + 5, 60);
    frames(20);
    expect(distanceFromEnd()).toBe(0);
    const last = BUFFER + 65;
    const mean = measuredFrom(last - BUFFER);
    let expected = 0;
    for (let seq = last - BUFFER; seq < last; seq++) {
      expected += measuredHeights.get(seq) ?? (seq >= BUFFER + 5 ? TALL_ROW : mean);
    }

    fireEvent.click(autoScroll());
    frames(20);

    expect(autoScroll()).not.toBeChecked();
    expect(list().scrollHeight).toBe(expected);
    expect(distanceFromEnd()).toBe(0);
  });

  it('counts the mean measured height and keeps the line in view when Auto-scroll goes off with every other line tall', () => {
    // As many measured lines are short as tall, so the most common height is a coin toss; the mean is not.
    const BUFFER = 1000;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (seq % 2 ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    readsPerNewLine(receive, BUFFER, 4);
    const last = BUFFER + 4;
    const rowsBefore = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="row"]'), row => [
        row.textContent ?? '',
        parseFloat(row.style.transform.replace('translateY(', '')) - list().scrollTop
      ]);
    const inView = rowsBefore().filter(([, top]) => (top as number) >= 0 && (top as number) < VIEWPORT);
    // The mean of the lines measured when the view stops following.
    const mean = measuredFrom(last - BUFFER);

    fireEvent.click(autoScroll());
    frames(20);

    let expected = 0;
    for (let seq = last - BUFFER; seq < last; seq++) {
      expected += measuredHeights.get(seq) ?? mean;
    }
    // The List sums row positions in floating point.
    expect(list().scrollHeight).toBeCloseTo(expected, 6);
    expect(rowsBefore().filter(([, top]) => (top as number) >= 0 && (top as number) < VIEWPORT)).toEqual(inView);
  });

  it('costs at most one extra pass when a run of tall lines ends (bound)', () => {
    // Nine tall lines every 40. Once nine tall lines in a row are measured, a new line is predicted tall, so the first
    // short line after the run costs one extra pass. No other line costs more than it does with the common height.
    const BUFFER = 1000;
    const isTall = (seq: number) => seq % 40 < 9;
    const receive = openTail({
      autoScroll: true,
      bufferSize: BUFFER,
      text: seq => (isTall(seq) ? `Line ${seq} TALL` : `Line ${seq}`)
    });
    readsPerNewLine(receive, BUFFER, 12);

    const first = BUFFER + 12;
    const readsPerLine = readsPerNewLine(receive, first, 80);

    expect(distanceFromEnd()).toBe(0);
    expect(readsPerLine).toEqual(
      readsPerLine.map((_, k) => (isTall(first + k) || (first + k) % 40 === 9 ? 2 * BUFFER : BUFFER))
    );
  });
});
