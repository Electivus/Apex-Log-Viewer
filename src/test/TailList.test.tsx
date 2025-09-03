import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
const proxyquire: any = require('proxyquire');

suite('TailList', () => {
  const t: any = {
    tail: {
      waiting: 'Waiting for logs…',
      pressStart: 'Press Start to tail logs.',
      debugTag: 'debug'
    }
  };

  function mountWithStubbedList({
    lines,
    filteredIndexes,
    onAtBottomChange
  }: {
    lines: string[];
    filteredIndexes: number[];
    onAtBottomChange?: (b: boolean) => void;
  }) {
    const captured: any = {};
    const List = (props: any) => {
      captured.overscanCount = props.overscanCount;
      return (
        <div
          ref={el => {
            captured.el = el as HTMLDivElement | null;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { TailList } = proxyquire('../webview/components/tail/TailList', {
      'react-window': { List }
    });

    const listRef = React.createRef<any>();
    render(
      <TailList
        lines={lines}
        filteredIndexes={filteredIndexes}
        selectedIndex={undefined}
        onSelectIndex={() => {}}
        colorize={false}
        running={true}
        listRef={listRef}
        t={t}
        onAtBottomChange={onAtBottomChange}
      />
    );
    return captured as { el: HTMLDivElement; overscanCount: number } & Record<string, any>;
  }

  test('adjusts overscan based on scroll speed', async () => {
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

    await new Promise(r => setTimeout(r, 0));
    assert.equal(captured.overscanCount > 8, true, 'overscan increases while fast scrolling');

    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(captured.overscanCount, 8, 'overscan decays back to base');
    (performance as any).now = originalNow;
  });

  test('onAtBottomChange triggers on mount and on scroll crossing threshold', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
    const filtered = lines.map((_, i) => i);
    const calls: boolean[] = [];
    const captured = mountWithStubbedList({
      lines,
      filteredIndexes: filtered,
      onAtBottomChange: b => calls.push(b)
    });

    const el = captured.el as HTMLDivElement;
    // Define dimensions so we start "at bottom"
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    el.scrollTop = 1000 - 300 - 2; // remaining = 2 (<= threshold 4)

    // Fire an initial scroll to ensure effect's compute sees values
    fireEvent.scroll(el);
    // wait for rAF-computed callback
    return new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
      assert.equal(calls.length > 0, true, 'initial atBottom computed');
    assert.equal(calls[calls.length - 1], true, 'initial state is atBottom');

    // Scroll up enough to exit bottom zone
      el.scrollTop = 500;
      fireEvent.scroll(el);
      return new Promise<void>(r => setTimeout(r, 0)).then(() => {
        assert.equal(calls[calls.length - 1], false, 'leaving bottom triggers false');

    // Return to bottom zone
        el.scrollTop = 1000 - 300 - 1;
        fireEvent.scroll(el);
        return new Promise<void>(r => setTimeout(r, 0)).then(() => {
          assert.equal(calls[calls.length - 1], true, 're-entering bottom triggers true');
        });
      });
    });
  });
});
