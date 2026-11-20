import React from 'react';
import { act, render, screen } from '@testing-library/react';

import { TailList } from '../components/tail/TailList';

/**
 * The real react-window List over a fake layout: jsdom lays nothing out, so the browser's answers come from here.
 * A line is SHORT pixels tall, or TALL when its text says so, the list shows VIEWPORT pixels, and a ResizeObserver
 * reports a size on the next task after `observe`, as a browser does after layout.
 */
const VIEWPORT = 200;
const SHORT = 18;
const TALL = 54;

const t = { tail: { waiting: 'Waiting for logs…', pressStart: 'Press Start to tail logs.', debugTag: 'debug' } };

const rowOf = (element: Element) => element.closest('[role="row"]');
const lineHeight = (row: Element) => (row.textContent?.includes('TALL') ? TALL : SHORT);
const isList = (element: Element) => element.getAttribute('role') === 'list';

function laidOutHeight(element: Element): number {
  const row = rowOf(element);
  return row ? lineHeight(row) : VIEWPORT;
}

class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
    setTimeout(() => {
      if (!this.targets.has(target)) {
        return;
      }
      const height = laidOutHeight(target);
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

const layout: Array<[string, PropertyDescriptor]> = [
  [
    'offsetHeight',
    {
      get: function (this: HTMLElement) {
        return laidOutHeight(this);
      }
    }
  ],
  [
    'clientHeight',
    {
      get: function (this: HTMLElement) {
        return laidOutHeight(this);
      }
    }
  ],
  [
    'scrollHeight',
    {
      get: function (this: HTMLElement) {
        if (isList(this)) {
          const sizer = this.querySelector<HTMLElement>('[data-react-window-sizer]');
          return parseFloat(sizer?.style.height ?? '0');
        }
        // What a browser reads for a row's content: the row without its 1 px bottom border.
        return rowOf(this) ? laidOutHeight(this) - 1 : VIEWPORT;
      }
    }
  ]
];

/** A buffer of `count` lines numbered from `first`, as the Tail panel holds it after older lines left. */
function buffer(first: number, count: number, tall: ReadonlySet<number> = new Set()) {
  const lines = Array.from({ length: count }, (_, i) => {
    const seq = first + i;
    return tall.has(seq) ? `Line ${seq} TALL` : `Line ${seq}`;
  });
  return { lines, filteredIndexes: lines.map((_, i) => i), firstLineSeq: first };
}

type Buffer = ReturnType<typeof buffer>;

function renderTail(initial: Buffer) {
  const ui = (current: Buffer, selectedIndex?: number) => (
    <TailList
      lines={current.lines}
      filteredIndexes={current.filteredIndexes}
      firstLineSeq={current.firstLineSeq}
      selectedIndex={selectedIndex}
      onSelectIndex={() => {}}
      colorize={false}
      running
      listRef={React.createRef()}
      follow={false}
      t={t as any}
    />
  );
  const view = render(ui(initial));
  settle();
  return {
    update: (next: Buffer, selectedIndex?: number) => {
      view.rerender(ui(next, selectedIndex));
      settle();
    }
  };
}

/** Runs the ResizeObserver reports and the renders they cause until the layout stops changing. */
function settle() {
  for (let frame = 0; frame < 10; frame++) {
    act(() => {
      jest.advanceTimersByTime(16);
    });
  }
}

const list = () => screen.getByRole('list');
const rowElement = (text: string) => rowOf(screen.getByText(text));

/** Scrolls as the user does, so the list renders and measures the rows that come into view. */
function scrollListTo(top: number) {
  act(() => {
    list().scrollTop = top;
    list().dispatchEvent(new Event('scroll'));
  });
  settle();
}

describe('TailList rows over the real virtual list', () => {
  const NoResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    for (const [name, descriptor] of layout) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.ResizeObserver = NoResizeObserver;
    for (const [name] of layout) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it('keeps a measured height with its line when older lines leave the buffer', () => {
    const { update } = renderTail(buffer(0, 40, new Set([0])));
    for (let top = 0; top <= 40 * SHORT; top += VIEWPORT / 2) {
      scrollListTo(top);
    }
    expect(list().scrollHeight).toBe(TALL + 39 * SHORT);
    expect(screen.queryByText('Line 0 TALL')).toBeNull();

    // The tall line leaves while it is out of view, so nothing measures the row that takes its place.
    update(buffer(1, 40, new Set([0])));

    expect(list().scrollHeight).toBe(40 * SHORT);
  });

  it('keeps each row element across renders and as older lines leave the buffer', () => {
    const { update } = renderTail(buffer(0, 5));
    const row = rowElement('Line 3');
    expect(row).not.toBeNull();

    update(buffer(0, 6), 1);
    expect(rowElement('Line 3')).toBe(row);

    update(buffer(2, 5), 0);
    expect(rowElement('Line 3')).toBe(row);
  });
});
