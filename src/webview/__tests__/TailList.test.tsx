import React from 'react';
import { fireEvent, render } from '@testing-library/react';

const t = {
  tail: {
    waiting: 'Waiting for logs…',
    pressStart: 'Press Start to tail logs.',
    debugTag: 'debug'
  }
};

describe('TailList', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  function mountWithStubbedList({
    lines,
    filteredIndexes,
    onAtBottomChange
  }: {
    lines: string[];
    filteredIndexes: number[];
    onAtBottomChange?: (value: boolean) => void;
  }) {
    jest.resetModules();
    const captured: Record<string, unknown> & { el?: HTMLDivElement; overscanCount?: number } = {};
    jest.doMock('react-window', () => ({
      List: ({ listRef, overscanCount }: any) => {
        captured.overscanCount = overscanCount;
        return (
          <div
            ref={el => {
              captured.el = el as HTMLDivElement | null;
              const api = { element: el, scrollToRow: () => {} };
              if (typeof listRef === 'function') {
                listRef(api);
              } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
                (listRef as { current: unknown }).current = api;
              }
            }}
          />
        );
      }
    }));
    const { TailList } = require('../components/tail/TailList') as typeof import('../components/tail/TailList');

    const listRef = React.createRef<any>();
    render(
      <TailList
        lines={lines}
        filteredIndexes={filteredIndexes}
        selectedIndex={undefined}
        onSelectIndex={() => {}}
        colorize={false}
        running
        listRef={listRef}
        t={t as any}
        onAtBottomChange={onAtBottomChange}
      />
    );
    return captured as { el: HTMLDivElement; overscanCount: number } & Record<string, unknown>;
  }

  it('adjusts overscan based on scroll speed', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`);
    const filtered = lines.map((_, i) => i);
    const captured = mountWithStubbedList({ lines, filteredIndexes: filtered });

    const el = captured.el as HTMLDivElement;
    const originalNow = performance.now.bind(performance);
    let now = 0;
    (performance as any).now = () => now;

    el.scrollTop = 20;
    fireEvent.scroll(el);
    now += 20;
    el.scrollTop = 120;
    fireEvent.scroll(el);
    now += 20;
    el.scrollTop = 260;
    fireEvent.scroll(el);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured.overscanCount).toBeGreaterThan(8);

    await new Promise(resolve => setTimeout(resolve, 250));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured.overscanCount).toBe(8);

    (performance as any).now = originalNow;
  });

  it('notifies when the list enters and leaves the bottom threshold', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
    const filtered = lines.map((_, i) => i);
    const calls: boolean[] = [];
    const captured = mountWithStubbedList({
      lines,
      filteredIndexes: filtered,
      onAtBottomChange: value => calls.push(value)
    });

    const el = captured.el as HTMLDivElement;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    el.scrollTop = 1000 - 300 - 2; // remaining = 2 (<= threshold 4)

    fireEvent.scroll(el);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBe(true);

    el.scrollTop = 500;
    fireEvent.scroll(el);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls[calls.length - 1]).toBe(false);

    el.scrollTop = 1000 - 300 - 1;
    fireEvent.scroll(el);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls[calls.length - 1]).toBe(true);
  });
});
