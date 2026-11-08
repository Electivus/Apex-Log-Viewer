import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { CustomLogEntry } from '@alv/protocol/customLogsTypes';
import { CustomLogEntryList } from '../components/custom-logs/CustomLogEntryList';
import type { RevealRequest } from '../components/custom-logs/useGridList';
import { getMessages } from '../i18n';
import { buildEntryColumns } from '../utils/customLogs/entries';

/**
 * The real react-window List over a fake layout: jsdom lays nothing out, so the browser's answers come from here.
 * Rows are as tall as `rowHeight` says, the list shows VIEWPORT pixels, and a ResizeObserver reports a size on
 * the next task after `observe`, as a browser does after layout.
 */
const VIEWPORT = 300;
let rowHeight: (entryId: string) => number = () => 26;
let scrolls: Array<{ at: number; top: number }> = [];

const entryIdIn = (element: Element) =>
  (element.matches('[data-entry-id]') ? element : element.querySelector('[data-entry-id]'))?.getAttribute(
    'data-entry-id'
  ) ?? undefined;
const isList = (element: Element) => element.getAttribute('role') === 'list';

function laidOutHeight(element: Element): number {
  if (isList(element)) {
    return VIEWPORT;
  }
  const entryId = entryIdIn(element);
  return entryId ? rowHeight(entryId) : 0;
}

class FakeResizeObserver {
  static readonly live = new Set<FakeResizeObserver>();
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.live.add(this);
  }

  /** The browser lays out every observed element again, as when rows reflow. */
  static reflow() {
    for (const observer of FakeResizeObserver.live) {
      observer.report([...observer.targets]);
    }
  }

  observe(target: Element) {
    this.targets.add(target);
    this.report([target]);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    FakeResizeObserver.live.delete(this);
  }

  private report(targets: Element[]) {
    setTimeout(() => {
      const entries = targets
        .filter(target => this.targets.has(target))
        .map(target => {
          const height = laidOutHeight(target);
          return {
            target,
            contentRect: { height, width: 800 },
            borderBoxSize: [{ blockSize: height, inlineSize: 800 }]
          } as unknown as ResizeObserverEntry;
        });
      if (entries.length > 0) {
        this.callback(entries, this as unknown as ResizeObserver);
      }
    });
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
        return isList(this) ? VIEWPORT : 0;
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
        // What a browser reads for a row: its height without the 1 px bottom border.
        return Math.max(0, laidOutHeight(this) - 1);
      }
    }
  ],
  [
    'scrollTo',
    {
      value: function (this: HTMLElement, options: ScrollToOptions) {
        scrolls.push({ at: performance.now(), top: options.top ?? 0 });
        this.scrollTop = options.top ?? 0;
        this.dispatchEvent(new Event('scroll'));
      }
    }
  ]
];

const t = getMessages('en').customLogs;
const columns = buildEntryColumns({
  labels: t.viewer.columns,
  extra: [],
  payload: [],
  discovered: [],
  hasOrigin: false
});
const NONE: ReadonlySet<string> = new Set();
const entryAt = (index: number): CustomLogEntry => ({
  id: `a01${String(index).padStart(12, '0')}AAA`,
  sequence: index + 1,
  time: '2026-10-29T23:29:49.000Z',
  level: 'INFO',
  rawLevel: 'INFO',
  message: `Order ${index} synced\nwith a payload that wraps to several lines`,
  previewClipped: false,
  system: false,
  presentDetails: [],
  extra: {}
});
const entries = Array.from({ length: 300 }, (_, index) => entryAt(index));
const target = entries[200]!;

function renderList(reveal?: RevealRequest) {
  return (
    <div style={{ height: VIEWPORT }}>
      <CustomLogEntryList
        t={t}
        entries={entries}
        columns={columns}
        sort={undefined}
        selectedId={target.id}
        discovered={[]}
        activeColumns={NONE}
        lockedColumns={NONE}
        onSort={() => {}}
        onSelect={() => {}}
        onToggleColumn={() => {}}
        onRemoveColumn={() => {}}
        reveal={reveal}
      />
    </div>
  );
}

/** The list shows its first rows, then the host answers that the entry the list opened is found. */
function openTarget() {
  const view = render(renderList());
  frames(5);
  view.rerender(renderList({ id: target.id, generation: 1 }));
}

const list = () => screen.getByRole('list');

/** Frames of 16 ms, each its own act, so React renders between them as a browser would. */
function frames(count: number, eachFrame?: () => void) {
  for (let frame = 0; frame < count; frame++) {
    act(() => {
      eachFrame?.();
      jest.advanceTimersByTime(16);
    });
  }
}

/** Where the target row lies against the list's viewport, from the offsets the List laid it out at. */
function placementOf(entry: CustomLogEntry): string {
  const row = list().querySelector(`[data-entry-id="${entry.id}"]`)?.parentElement;
  if (!row) {
    return 'not rendered';
  }
  const top = Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);
  const bottom = top + rowHeight(entry.id);
  const { scrollTop } = list();
  return top >= scrollTop && bottom <= scrollTop + VIEWPORT
    ? 'in view'
    : `at ${top}-${bottom}, viewport ${scrollTop}-${scrollTop + VIEWPORT}`;
}

describe('revealing an entry in the entry list', () => {
  const NoResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    scrolls = [];
    rowHeight = () => 60;
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

  it('follows the entry into view while the rows above it measure taller than the estimate', () => {
    openTarget();

    frames(30);

    expect(placementOf(target)).toBe('in view');
    expect(scrolls.length).toBeGreaterThan(1);
  });

  it.each(['wheel', 'pointerdown'] as const)('stops following once the user scrolls with a %s', gesture => {
    openTarget();
    const before = scrolls.length;
    expect(before).toBeGreaterThan(0);

    fireEvent[gesture === 'wheel' ? 'wheel' : 'pointerDown'](list());
    frames(30);

    expect(scrolls).toHaveLength(before);
    expect(placementOf(target)).not.toBe('in view');
  });

  it('gives up after a bound when the rows above it never settle', () => {
    openTarget();
    let growth = 0;

    frames(190, () => {
      growth += 1;
      rowHeight = () => 60 + growth;
      FakeResizeObserver.reflow();
    });

    const startedAt = scrolls[0]!.at;
    expect(scrolls.filter(scroll => scroll.at - startedAt < 1_000).length).toBeGreaterThan(10);
    expect(scrolls.filter(scroll => scroll.at - startedAt > 2_000)).toEqual([]);
  });
});
