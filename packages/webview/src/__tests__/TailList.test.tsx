import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

import { TailList } from '../components/tail/TailList';

type TailListInputs = Parameters<typeof TailList>[0];

/** A test double for react-window's `List`, whose own return type the doubles do not match. */
const asVirtualList = (component: (props: any) => React.ReactElement) =>
  component as unknown as NonNullable<TailListInputs['virtualListComponent']>;

const CLIENT_HEIGHT = 200;

type ListHarness = {
  element: HTMLDivElement | null;
  overscanCount?: number;
  /** Height of each row in the fake layout. */
  rowHeight: number;
  /** Extra height, standing in for the list refining its size estimate after a scroll. */
  extraHeight: number;
  /** Re-render the list on its own, as react-window does after a scroll. */
  rerenderList: () => void;
};

const t = {
  tail: {
    waiting: 'Waiting for logs…',
    pressStart: 'Press Start to tail logs.',
    debugTag: 'debug'
  }
};

/** Gives the element a scroll geometry that clamps like a browser does. */
function defineScrollGeometry(el: HTMLDivElement, contentHeight: () => number) {
  let top = 0;
  const maxTop = () => Math.max(0, contentHeight() - CLIENT_HEIGHT);
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => CLIENT_HEIGHT });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(CLIENT_HEIGHT, contentHeight())
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => Math.min(top, maxTop()),
    set: (value: number) => {
      top = Math.max(0, Math.min(value, maxTop()));
    }
  });
}

/**
 * Stands in for react-window's List. Like the real one, it keeps its element in state and
 * publishes the imperative handle with it, so the handle's element is null after the first
 * commit, and it reports rendered rows after every render.
 */
function createVirtualList(harness: ListHarness) {
  return function VirtualList({ listRef, overscanCount, rowCount, onRowsRendered }: any) {
    harness.overscanCount = overscanCount;
    const [element, setElement] = React.useState<HTMLDivElement | null>(null);
    const [, setTick] = React.useState(0);
    harness.rerenderList = () => setTick(value => value + 1);
    const rowCountRef = React.useRef<number>(rowCount);
    rowCountRef.current = rowCount;
    React.useImperativeHandle(
      listRef,
      () => ({
        get element() {
          return element;
        },
        scrollToRow: () => {}
      }),
      [element]
    );
    React.useEffect(() => {
      const range = { startIndex: 0, stopIndex: rowCount - 1 };
      onRowsRendered?.(range, range);
    });
    const attach = React.useCallback((el: HTMLDivElement | null) => {
      if (el) {
        defineScrollGeometry(el, () => rowCountRef.current * harness.rowHeight + harness.extraHeight);
      }
      harness.element = el;
      setElement(el);
    }, []);
    return <div ref={attach} />;
  };
}

function linesOf(count: number): Pick<TailListInputs, 'lines' | 'filteredIndexes'> {
  const lines = Array.from({ length: count }, (_, i) => `Line ${i}`);
  return { lines, filteredIndexes: lines.map((_, i) => i) };
}

describe('TailList', () => {
  function renderTailList(
    initial: Pick<TailListInputs, 'lines' | 'filteredIndexes'> &
      Partial<Pick<TailListInputs, 'follow' | 'onAtBottomChange'>>
  ) {
    const harness: ListHarness = { element: null, rowHeight: 20, extraHeight: 0, rerenderList: () => {} };
    const virtualList = createVirtualList(harness);
    const listRef = React.createRef<any>();
    const ui = (props: typeof initial) => (
      <TailList
        lines={props.lines}
        filteredIndexes={props.filteredIndexes}
        selectedIndex={undefined}
        onSelectIndex={() => {}}
        colorize={false}
        running
        listRef={listRef}
        follow={props.follow ?? false}
        t={t as any}
        onAtBottomChange={props.onAtBottomChange}
        virtualListComponent={asVirtualList(virtualList)}
      />
    );
    let current = initial;
    const view = render(ui(current));
    const update = (next: Partial<typeof initial>) => {
      current = { ...current, ...next };
      act(() => {
        view.rerender(ui(current));
      });
    };
    const element = () => {
      if (!harness.element) throw new Error('list element is not mounted');
      return harness.element;
    };
    const bottom = () => element().scrollHeight - element().clientHeight;
    const userScrollTo = (top: number) => {
      act(() => {
        element().scrollTop = top;
        fireEvent.scroll(element());
      });
    };
    return { harness, listRef, update, element, bottom, userScrollTo };
  }

  it('adjusts overscan based on scroll speed', async () => {
    const { harness, element } = renderTailList(linesOf(50));

    const el = element();
    const originalNow = performance.now.bind(performance);
    let now = 0;
    (performance as any).now = () => now;

    await act(async () => {
      el.scrollTop = 20;
      fireEvent.scroll(el);
      now += 20;
      el.scrollTop = 120;
      fireEvent.scroll(el);
      now += 20;
      el.scrollTop = 260;
      fireEvent.scroll(el);
      await Promise.resolve();
    });
    expect(harness.overscanCount as number).toBeGreaterThan(8);

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(harness.overscanCount).toBe(8);

    (performance as any).now = originalNow;
  });

  it('wraps a line that has no spaces instead of clipping it', () => {
    const header =
      'APEX_CODE,DEBUG;APEX_PROFILING,ERROR;CALLOUT,ERROR;DB,INFO;NBA,ERROR;SYSTEM,DEBUG;VISUALFORCE,ERROR;WAVE,INFO';
    for (const colorize of [false, true]) {
      const view = render(
        <TailList
          lines={[header]}
          filteredIndexes={[0]}
          selectedIndex={undefined}
          onSelectIndex={() => {}}
          colorize={colorize}
          running
          listRef={React.createRef()}
          follow={false}
          t={t as any}
          virtualListComponent={
            function RowsList({ rowComponent: Row }: any) {
              return <Row index={0} style={{}} />;
            } as any
          }
        />
      );
      const line = view.getByRole('row').firstElementChild as HTMLDivElement;
      expect(line.textContent).toBe(header);
      expect(line.style.whiteSpace).toBe('pre-wrap');
      expect(line.style.overflowWrap).toBe('anywhere');
      view.unmount();
    }
  });

  it('notifies when the list enters and leaves the bottom threshold', () => {
    const calls: boolean[] = [];
    const { userScrollTo, bottom } = renderTailList({ ...linesOf(50), onAtBottomChange: value => calls.push(value) });

    userScrollTo(bottom() - 2);
    expect(calls).toEqual([true]);

    userScrollTo(300);
    expect(calls).toEqual([true, false]);

    userScrollTo(bottom() - 1);
    expect(calls).toEqual([true, false, true]);
  });

  it('exposes the list API through listRef once the element exists', () => {
    const { listRef, element } = renderTailList(linesOf(5));
    expect(listRef.current?.element).toBe(element());
  });

  it('shows the newest line when the first batch arrives with follow on', () => {
    const { update, element, bottom } = renderTailList({ ...linesOf(0), follow: true });

    update(linesOf(50));

    expect(bottom()).toBe(50 * 20 - CLIENT_HEIGHT);
    expect(element().scrollTop).toBe(bottom());
  });

  it('keeps the newest line in view as lines arrive and rows grow', () => {
    const { harness, update, element, bottom } = renderTailList({ ...linesOf(50), follow: true });
    expect(element().scrollTop).toBe(bottom());

    update(linesOf(80));
    expect(element().scrollTop).toBe(bottom());

    // Rows measured taller than the estimate: TailList re-renders with the new heights.
    harness.rowHeight = 32;
    update(linesOf(81));
    expect(element().scrollTop).toBe(81 * 32 - CLIENT_HEIGHT);

    // The list renders the last rows and refines its height estimate on its own.
    harness.extraHeight = 520;
    act(() => harness.rerenderList());
    expect(element().scrollTop).toBe(bottom());
    expect(bottom()).toBe(81 * 32 + 520 - CLIENT_HEIGHT);
  });

  it('stops following once the user scrolls up', () => {
    const calls: boolean[] = [];
    const { update, element, userScrollTo } = renderTailList({
      ...linesOf(50),
      follow: true,
      onAtBottomChange: value => calls.push(value)
    });

    userScrollTo(300);
    expect(calls).toEqual([false]);

    // New lines before the parent turned follow off must not pull the view back down.
    update(linesOf(60));
    expect(element().scrollTop).toBe(300);

    update({ ...linesOf(70), follow: false });
    expect(element().scrollTop).toBe(300);
  });

  it('does not undo a scroll up whose scroll event has not fired yet', () => {
    const { update, element } = renderTailList({ ...linesOf(50), follow: true });

    act(() => {
      element().scrollTop = 300;
    });
    update(linesOf(60));

    expect(element().scrollTop).toBe(300);
  });

  it('follows again after the user returns to the bottom and follow turns back on', () => {
    const calls: boolean[] = [];
    const { update, element, bottom, userScrollTo } = renderTailList({
      ...linesOf(50),
      follow: true,
      onAtBottomChange: value => calls.push(value)
    });

    userScrollTo(300);
    update({ follow: false });
    userScrollTo(bottom());
    expect(calls).toEqual([false, true]);

    update({ ...linesOf(60), follow: true });
    expect(element().scrollTop).toBe(bottom());

    update(linesOf(70));
    expect(element().scrollTop).toBe(bottom());
  });

  it('jumps to the end when follow is turned on and leaves the view alone while it is off', () => {
    const { update, element, bottom } = renderTailList({ ...linesOf(50), follow: false });
    expect(element().scrollTop).toBe(0);

    update(linesOf(60));
    expect(element().scrollTop).toBe(0);

    update({ follow: true });
    expect(element().scrollTop).toBe(bottom());
  });
});
