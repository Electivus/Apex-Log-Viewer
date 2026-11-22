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

/** Called with the layout a browser would paint, before each ResizeObserver report. */
let beforeReport: (() => void) | undefined;

class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
    setTimeout(() => {
      if (!this.targets.has(target)) {
        return;
      }
      beforeReport?.();
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
  ],
  [
    // A browser keeps the scroll offset within the content, so a list that shrinks under it moves it.
    'scrollTop',
    {
      get: function (this: HTMLElement) {
        return clampScroll(this, scrollTops.get(this) ?? 0);
      },
      set: function (this: HTMLElement, top: number) {
        scrollTops.set(this, clampScroll(this, top));
      }
    }
  ]
];

const scrollTops = new WeakMap<HTMLElement, number>();

function clampScroll(element: HTMLElement, top: number) {
  const clamped = Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, top));
  scrollTops.set(element, clamped);
  return clamped;
}

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

/** Where the row of each rendered line sits in the viewport, from the offset the List gave it and the scroll offset. */
function viewportTops() {
  const scrollTop = list().scrollTop;
  return new Map(
    Array.from(document.querySelectorAll<HTMLElement>('[role="row"]'), row => [
      row.textContent ?? '',
      parseFloat(row.style.transform.replace('translateY(', '')) - scrollTop
    ])
  );
}

/** Where `line` sits in the viewport or, when it is not rendered, which line is first in view instead. */
function placeOf(line: string) {
  const tops = viewportTops();
  const top = tops.get(line);
  if (top !== undefined) {
    return `${line} at ${top}`;
  }
  const [first, firstTop] = [...tops].find(([, rowTop]) => rowTop >= 0) ?? ['nothing', 0];
  return `${line} not rendered; ${first} at ${firstTop}`;
}

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
    beforeReport = undefined;
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

  it('keeps the measured height of a line out of view that stays in the buffer', () => {
    const { update } = renderTail(buffer(0, 40, new Set([0, 1])));
    for (let top = 0; top <= 40 * SHORT; top += VIEWPORT / 2) {
      scrollListTo(top);
    }
    expect(list().scrollHeight).toBe(2 * TALL + 38 * SHORT);

    // Line 0 leaves; line 1 stays out of view, so only the height kept for it can count.
    update(buffer(1, 40, new Set([1])));

    expect(screen.queryByText('Line 1 TALL')).toBeNull();
    expect(list().scrollHeight).toBe(TALL + 39 * SHORT);
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

  // The first lines get measured at the top, then the view jumps far below, so most lines above the view are placed
  // by the List's estimate. Lines from 200 on tall: the lines that leave are short and measured. Every other line
  // tall: the lines that leave alternate, as in #1564.
  it.each([
    ['from line 200 on', (seq: number) => seq >= 200],
    ['every other line', (seq: number) => seq % 2 === 1]
  ])(
    'keeps the rows in view in place while Auto-scroll is off and lines leave the buffer one at a time, tall %s',
    (_, isTall) => {
      const COUNT = 400;
      const DROPS = 20;
      const tall = new Set(Array.from({ length: COUNT + DROPS }, (_, seq) => seq).filter(isTall));
      const { update } = renderTail(buffer(0, COUNT, tall));
      scrollListTo(220 * SHORT);
      const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];
      expect(line).toMatch(/^Line \d+/);

      // Each update adds a line at the end and drops one from the head. In every layout, the line that was first in
      // view stays where it was.
      const places = [];
      const expected = [];
      for (let first = 1; first <= DROPS; first++) {
        const layouts = new Set<string>();
        beforeReport = () => layouts.add(placeOf(line));
        update(buffer(first, COUNT, tall));
        layouts.add(placeOf(line));
        places.push([...layouts]);
        expected.push([`${line} at ${top}`]);
      }
      expect(places).toEqual(expected);
    }
  );

  it('keeps the rows in view in place at the end while Auto-scroll is off and the list shrinks', () => {
    // The filter hides the new line, so the line that leaves the head makes the list one row shorter, and the
    // browser has already pulled the scroll offset back to the new end when the list reads it.
    const shown = (current: Buffer) => ({
      ...current,
      filteredIndexes: current.filteredIndexes.filter(i => current.firstLineSeq + i < 40)
    });
    const { update } = renderTail(shown(buffer(0, 40)));
    scrollListTo(40 * SHORT);
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    update(shown(buffer(1, 40)));

    expect(placeOf(line)).toBe(`${line} at ${top}`);
  });

  it('keeps the rows in view in place while Auto-scroll is off and many lines leave at once, shown or not', () => {
    // Lines 0-49 are tall and only the first ones get measured at the top. The filter hides every third line. Then the
    // view jumps far below, and one update drops 40 lines: measured, counted at the estimate, and hidden ones.
    const COUNT = 400;
    const tall = new Set(Array.from({ length: 50 }, (_, seq) => seq));
    const filtered = (current: Buffer) => ({
      ...current,
      filteredIndexes: current.filteredIndexes.filter(i => (current.firstLineSeq + i) % 3 !== 0)
    });
    const { update } = renderTail(filtered(buffer(0, COUNT, tall)));
    scrollListTo(150 * SHORT);
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    const layouts = new Set<string>();
    beforeReport = () => layouts.add(placeOf(line));
    update(filtered(buffer(40, COUNT, tall)));
    layouts.add(placeOf(line));

    expect([...layouts]).toEqual([`${line} at ${top}`]);
  });

  it('keeps the rows in view in place while Auto-scroll is off and rows above them get measured late', () => {
    // Lines 270-291 are tall and were never rendered, so the List places them at the estimate. The view sits a few
    // rows below them, then one update drops 40 lines from the head. Making up for those lines is not a scroll by the
    // user: it must not render more rows above the view, and a tall row that does get measured there must not move
    // the rows in view.
    const COUNT = 400;
    const tall = new Set(Array.from({ length: 22 }, (_, i) => 270 + i));
    const { update } = renderTail(buffer(0, COUNT, tall));
    scrollListTo(320 * SHORT);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    scrollListTo(300 * SHORT + 3);
    act(() => {
      jest.advanceTimersByTime(300);
    });
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop + SHORT > 0) ?? ['', 0];
    expect(line).toBe('Line 300');

    const layouts = new Set<string>();
    beforeReport = () => layouts.add(placeOf(line));
    update(buffer(40, COUNT, tall));
    layouts.add(placeOf(line));

    expect([...layouts]).toEqual([`${line} at ${top}`]);
  });

  it('keeps the rows in view in place while Auto-scroll is off and the user scrolls up over taller rows', () => {
    // Lines 260-301 are tall and were never rendered. The user scrolls up by one row, so a row that comes
    // in above the view is measured taller than the List placed it, and the row the user reads moves by the scroll only.
    const COUNT = 400;
    const tall = new Set(Array.from({ length: 42 }, (_, i) => 260 + i));
    renderTail(buffer(0, COUNT, tall));
    scrollListTo(330 * SHORT);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    scrollListTo(310 * SHORT);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    // The user moves up by one short row: the line moves down by exactly that much, whatever gets measured above it.
    const layouts = new Set<string>();
    beforeReport = () => layouts.add(placeOf(line));
    scrollListTo(list().scrollTop - SHORT);
    layouts.add(placeOf(line));

    expect([...layouts]).toEqual([`${line} at ${top + SHORT}`]);
  });
});
