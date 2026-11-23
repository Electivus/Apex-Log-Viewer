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

/** Delivers a report the way the browser does, for a test that sends one late. */
let report: ((entry: ResizeObserverEntry) => void) | undefined;

class FakeResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    report = entry => this.callback([entry], this as unknown as ResizeObserver);
  }

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
        if (heldThumb !== undefined) {
          const held = heldThumb;
          setTimeout(() => {
            scrollTops.set(this, held);
            // A frame is painted at the restored offset before the List hears of it.
            beforeReport?.();
            this.dispatchEvent(new Event('scroll'));
          }, 16);
        }
      }
    }
  ]
];

const scrollTops = new WeakMap<HTMLElement, number>();
/** Under page zoom a browser keeps the offset in device pixels, so a written offset comes back rounded to this. */
let scrollStep: number | undefined;
/** While set, the user holds the scrollbar thumb: the browser puts the offset back here on the next frame. */
let heldThumb: number | undefined;

function clampScroll(element: HTMLElement, top: number) {
  let clamped = Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, top));
  if (scrollStep !== undefined) {
    clamped = Math.round(clamped / scrollStep) * scrollStep;
  }
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
    scrollStep = undefined;
    heldThumb = undefined;
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

  it('keeps the rows in view in place at the end while Auto-scroll is off and the list shrinks (guard: passes on main)', () => {
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

  it('leaves the offset to a scroll under way while lines arrive, then keeps the line where it stopped', () => {
    // A smooth scroll, a key or a wheel moves the offset over several frames. Lines that arrive meanwhile must not
    // make this code write the offset, or the scroll stops short.
    const { update } = renderTail(buffer(0, 400));
    scrollListTo(100 * SHORT);
    const steps = [130, 160, 190, 220].map(row => row * SHORT);
    let first = 0;
    for (const step of steps) {
      act(() => {
        list().scrollTop = step;
        list().dispatchEvent(new Event('scroll'));
      });
      first += 10;
      update(buffer(first, 400));
      expect(list().scrollTop).toBe(step);
    }
    settle();
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    for (let more = 1; more <= 5; more++) {
      update(buffer(first + more * 10, 400));
      expect(placeOf(line)).toBe(`${line} at ${top}`);
    }
  });

  it('does not take its own correction for a scroll of the user', () => {
    // The scroll event of the offset this code sets must not stop the next correction.
    const { update } = renderTail(buffer(0, 400));
    scrollListTo(200 * SHORT);
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    for (let first = 1; first <= 6; first++) {
      update(buffer(first, 400));
      act(() => {
        list().dispatchEvent(new Event('scroll'));
      });
    }

    expect(placeOf(line)).toBe(`${line} at ${top}`);
  });

  it('keeps the line in view within a pixel over many updates when the browser rounds the scroll offset', () => {
    // At 110% zoom, a browser keeps the offset in device pixels, so every offset written comes back rounded.
    scrollStep = 1 / 1.1;
    const COUNT = 400;
    const UPDATES = 120;
    const tall = new Set(Array.from({ length: COUNT + UPDATES }, (_, seq) => seq).filter(seq => seq % 2 === 1));
    const { update } = renderTail(buffer(0, COUNT, tall));
    scrollListTo(250 * SHORT + 0.4);
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop + SHORT > 0) ?? ['', 0];

    const drifts = [];
    for (let first = 1; first <= UPDATES; first++) {
      update(buffer(first, COUNT, tall));
      drifts.push(Math.abs((viewportTops().get(line) ?? Infinity) - top));
    }

    expect(Math.max(...drifts)).toBeLessThanOrEqual(1);
  });

  it('does not move the view for a late measurement of a line that already left the buffer (guard: passes on main)', () => {
    const { update } = renderTail(buffer(0, 400));
    scrollListTo(200 * SHORT);
    update(buffer(40, 400));
    const [line, top] = [...viewportTops()].find(([, rowTop]) => rowTop >= 0) ?? ['', 0];

    // The browser reports a size for line 0's old row, placed where it sat, after the line left.
    const gone = document.createElement('div');
    gone.setAttribute('data-line-seq', '0');
    gone.style.transform = 'translateY(0px)';
    act(() => {
      report?.({
        target: gone,
        contentRect: { height: 200, width: 800 },
        borderBoxSize: [{ blockSize: 200, inlineSize: 800 }]
      } as unknown as ResizeObserverEntry);
    });
    settle();

    expect(placeOf(line)).toBe(`${line} at ${top}`);
  });

  it('never leaves the top of the view without a row while the user holds the scrollbar thumb (guard: passes on main)', () => {
    const { update } = renderTail(buffer(0, 400));
    scrollListTo(200 * SHORT);
    // The user presses the thumb; the browser keeps the offset where the thumb is until release.
    heldThumb = list().scrollTop;
    act(() => {
      list().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

    const uncovered: string[] = [];
    for (let first = 40; first <= 160; first += 40) {
      beforeReport = () => {
        const tops = [...viewportTops().values()];
        if (!tops.some(rowTop => rowTop <= 0 && rowTop + SHORT > 0)) {
          uncovered.push(`after line ${first} arrived`);
        }
      };
      update(buffer(first, 400));
    }
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'));
    });
    heldThumb = undefined;

    expect(uncovered).toEqual([]);
  });
});
