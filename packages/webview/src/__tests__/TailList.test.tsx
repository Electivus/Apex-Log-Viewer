import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

import { TailList } from '../components/tail/TailList';

type TailListInputs = Parameters<typeof TailList>[0];

type CapturedList = {
  element?: HTMLDivElement | null;
  overscanCount?: number;
};

const t = {
  tail: {
    waiting: 'Waiting for logs…',
    pressStart: 'Press Start to tail logs.',
    debugTag: 'debug'
  }
};

function createVirtualList(captured: CapturedList) {
  return function VirtualList({ listRef, overscanCount }: any) {
    captured.overscanCount = overscanCount;
    return (
      <div
        ref={el => {
          captured.element = el as HTMLDivElement | null;
          const api = { element: el, scrollToRow: () => {} };
          if (typeof listRef === 'function') {
            listRef(api);
          } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
            (listRef as { current: unknown }).current = api;
          }
        }}
      />
    );
  };
}

describe('TailList', () => {
  function renderTailList({
    lines,
    filteredIndexes,
    onAtBottomChange
  }: Pick<TailListInputs, 'lines' | 'filteredIndexes' | 'onAtBottomChange'>) {
    const captured: CapturedList = {};
    const virtualList = createVirtualList(captured);
    render(
      <TailList
        lines={lines}
        filteredIndexes={filteredIndexes}
        selectedIndex={undefined}
        onSelectIndex={() => {}}
        colorize={false}
        running
        listRef={React.createRef()}
        t={t as any}
        onAtBottomChange={onAtBottomChange}
        virtualListComponent={virtualList}
      />
    );
    return captured as { element: HTMLDivElement } & CapturedList;
  }

  it('adjusts overscan based on scroll speed', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
    const filtered = lines.map((_, i) => i);
    const captured = renderTailList({ lines, filteredIndexes: filtered });

    const el = captured.element;
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
    expect(captured.overscanCount as number).toBeGreaterThan(8);

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(captured.overscanCount).toBe(8);

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

  it('notifies when the list enters and leaves the bottom threshold', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
    const filtered = lines.map((_, i) => i);
    const calls: boolean[] = [];
    const captured = renderTailList({
      lines,
      filteredIndexes: filtered,
      onAtBottomChange: value => calls.push(value)
    });

    const el = captured.element;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });

    await act(async () => {
      el.scrollTop = 1000 - 300 - 2;
      fireEvent.scroll(el);
      await Promise.resolve();
    });
    expect(calls.at(-1)).toBe(true);

    await act(async () => {
      el.scrollTop = 500;
      fireEvent.scroll(el);
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.at(-1)).toBe(false));

    await act(async () => {
      el.scrollTop = 1000 - 300 - 1;
      fireEvent.scroll(el);
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.at(-1)).toBe(true));
  });
});
