import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useAdaptiveList } from '../../webview/utils/useAdaptiveList';

type HarnessHandle = ReturnType<typeof useAdaptiveList> & { listEl: HTMLDivElement | null };

const Harness = React.forwardRef<HarnessHandle, { itemCount: number; hasMore?: boolean; loading?: boolean; onLoadMore?: () => void }>(
  ({ itemCount, hasMore = false, loading = false, onLoadMore }, ref) => {
    const listRef = React.useRef<any>({ element: null });
    const adaptive = useAdaptiveList({ listRef, defaultRowHeight: 20, itemCount, hasMore, loading, onLoadMore });
    const { outerRef } = adaptive;
    React.useImperativeHandle(ref, () => ({ ...adaptive, listEl: listRef.current?.element ?? null }));
    return (
      <div ref={outerRef}>
        <div
          ref={el => {
            if (listRef.current) listRef.current.element = el;
          }}
        />
      </div>
    );
  }
);

suite('useAdaptiveList', () => {
  test('adjusts overscan with scroll speed', async () => {
    const ref = React.createRef<HarnessHandle>();
    render(<Harness ref={ref} itemCount={50} />);
    const el = ref.current!.listEl!;
    const originalNow = performance.now.bind(performance);
    let now = 0;
    (performance as any).now = () => now;

    el.scrollTop = 10;
    fireEvent.scroll(el);
    now += 20;
    el.scrollTop = 120;
    fireEvent.scroll(el);
    now += 20;
    el.scrollTop = 260;
    fireEvent.scroll(el);

    await new Promise(r => setTimeout(r, 0));
    assert.equal(ref.current!.overscanCount > 8, true);
    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(ref.current!.overscanCount, 8);
    (performance as any).now = originalNow;
  });

  test('updates row height and reports via getItemSize', () => {
    const ref = React.createRef<HarnessHandle>();
    render(<Harness ref={ref} itemCount={5} />);
    ref.current!.setRowHeight(0, 50);
    assert.equal(ref.current!.getItemSize(0), 50);
  });

  test('invokes load more on rows rendered near end', () => {
    const ref = React.createRef<HarnessHandle>();
    let loads = 0;
    render(<Harness ref={ref} itemCount={30} hasMore={true} loading={false} onLoadMore={() => loads++} />);
    ref.current!.onRowsRendered({ startIndex: 0, stopIndex: 29 });
    assert.equal(loads > 0, true);
  });
});
