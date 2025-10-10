import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ApexLogRow } from '../shared/types';
import { LogsTable } from '../components/LogsTable';

type CapturedList = {
  outer?: HTMLDivElement | null;
  onRowsRendered?: (args: { startIndex: number; stopIndex: number }) => void;
  overscanCount?: number;
};

function createRows(n: number): ApexLogRow[] {
  return Array.from({ length: n }, (_, i) => ({
    Id: String(i),
    StartTime: new Date().toISOString(),
    Operation: 'Op',
    Application: 'App',
    DurationMilliseconds: 1,
    Status: 'Success',
    Request: '',
    LogLength: 100,
    LogUser: { Name: 'User' }
  }));
}

const t = {
  open: 'Open',
  replay: 'Replay',
  columns: {
    user: 'User',
    application: 'Application',
    operation: 'Operation',
    time: 'Time',
    duration: 'Duration',
    status: 'Status',
    codeUnitStarted: 'Code Unit',
    size: 'Size',
    match: 'Match'
  }
};

function createVirtualList(captured: CapturedList) {
  return function VirtualList({
    listRef,
    rowCount,
    rowHeight,
    rowComponent,
    rowProps,
    style,
    overscanCount,
    onRowsRendered
  }: any) {
    captured.overscanCount = overscanCount;
    captured.onRowsRendered = onRowsRendered;
    return (
      <div
        style={style}
        ref={el => {
          captured.outer = el as HTMLDivElement | null;
          const api = { element: el, scrollToRow: () => {} };
          if (typeof listRef === 'function') {
            listRef(api);
          } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
            (listRef as { current: unknown }).current = api;
          }
        }}
      >
        {Array.from({ length: rowCount }).map((_, index) => (
          <div key={index}>{rowComponent({ ...rowProps, index, style: { height: rowHeight(index) } })}</div>
        ))}
      </div>
    );
  };
}

describe('LogsTable', () => {
  function renderTable({
    rows = createRows(10),
    hasMore = true,
    loading = false,
    captured,
    autoLoadEnabled,
    fullLogSearchEnabled = true
  }: {
    rows?: ApexLogRow[];
    hasMore?: boolean;
    loading?: boolean;
    captured: CapturedList;
    autoLoadEnabled?: boolean;
    fullLogSearchEnabled?: boolean;
  }) {
    const loadMoreMock = jest.fn();
    const virtualList = createVirtualList(captured);
    const baseProps = {
      rows,
      logHead: {},
      matchSnippets: {},
      t: t as any,
      onOpen: () => {},
      onReplay: () => {},
      loading,
      locale: 'en-US',
      hasMore,
      sortBy: 'time' as const,
      sortDir: 'asc' as const,
      onSort: () => {}
    };
    const view = render(
      <LogsTable
        {...baseProps}
        autoLoadEnabled={autoLoadEnabled}
        onLoadMore={loadMoreMock}
        virtualListComponent={virtualList}
        fullLogSearchEnabled={fullLogSearchEnabled}
      />
    );
    return {
      loadMoreMock,
      rerender: (next: Partial<typeof baseProps> & { fullLogSearchEnabled?: boolean }) =>
        view.rerender(
          <LogsTable
            {...baseProps}
            {...next}
            autoLoadEnabled={autoLoadEnabled}
            onLoadMore={loadMoreMock}
            virtualListComponent={virtualList}
            fullLogSearchEnabled={next.fullLogSearchEnabled ?? fullLogSearchEnabled}
          />
        )
    };
  }

  it('requests more data via onRowsRendered before any scroll occurs', () => {
    const rows = createRows(30);
    const captured: CapturedList = {};
    const { loadMoreMock } = renderTable({ rows, captured });
    captured.onRowsRendered?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).toHaveBeenCalled();
  });

  it('does not auto-load when the list fits within the viewport and auto load is disabled', () => {
    const rows = createRows(5);
    const captured: CapturedList = {};
    const { loadMoreMock } = renderTable({ rows, captured, autoLoadEnabled: false });
    captured.onRowsRendered?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).not.toHaveBeenCalled();
  });

  it('auto-loads when viewport is short but auto load is enabled', () => {
    const rows = createRows(5);
    const captured: CapturedList = {};
    const { loadMoreMock } = renderTable({ rows, captured, autoLoadEnabled: true });
    captured.onRowsRendered?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).toHaveBeenCalled();
  });

  it('requests more data after user scrolls near the end', async () => {
    const rows = createRows(80);
    const captured: CapturedList = {};
    const { loadMoreMock } = renderTable({ rows, captured });
    const outer = captured.outer as HTMLDivElement;
    Object.defineProperty(outer, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(outer, 'scrollHeight', { value: 1200, configurable: true });
    await act(async () => {
      outer.scrollTop = 10;
      fireEvent.scroll(outer);
    });
    captured.onRowsRendered?.({ startIndex: rows.length - 10, stopIndex: rows.length - 1 });
    expect(loadMoreMock).toHaveBeenCalled();
  });

  it('adjusts overscan while scrolling quickly', async () => {
    const captured: CapturedList = {};
    renderTable({ rows: createRows(5), hasMore: false, captured });
    const outer = captured.outer as HTMLDivElement;
    const originalNow = performance.now.bind(performance);
    let now = 0;
    (performance as any).now = () => now;

    await act(async () => {
      outer.scrollTop = 50;
      fireEvent.scroll(outer);
      now += 20;
      outer.scrollTop = 100;
      fireEvent.scroll(outer);
      now += 20;
      outer.scrollTop = 200;
      fireEvent.scroll(outer);
      await Promise.resolve();
    });
    expect(captured.overscanCount as number).toBeGreaterThan(8);

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(captured.overscanCount).toBe(8);
    (performance as any).now = originalNow;
  });

  it('shows match column and hides code unit when full log search is enabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: true });
    expect(screen.queryByText('Code Unit')).toBeNull();
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('shows code unit column and hides match when full log search is disabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: false });
    expect(screen.getByText('Code Unit')).toBeInTheDocument();
    expect(screen.queryByText('Match')).toBeNull();
  });

  it('uses bottom proximity as a fallback trigger for pagination', async () => {
    const captured: CapturedList = {};
    const { loadMoreMock } = renderTable({ rows: createRows(200), captured });
    const el = captured.outer as HTMLDivElement;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    const originalNow = performance.now.bind(performance);
    (performance as any).now = () => 1000;

    await act(async () => {
      el.scrollTop = 1000 - 300 - 20;
      fireEvent.scroll(el);
    });
    expect(loadMoreMock).toHaveBeenCalled();
    (performance as any).now = originalNow;
  });

  it('avoids loading more when already loading or when hasMore is false', () => {
    const rows = createRows(50);
    const captured: CapturedList = {};
    const { loadMoreMock, rerender } = renderTable({ rows, loading: true, hasMore: true, captured });
    captured.onRowsRendered?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).not.toHaveBeenCalled();

    loadMoreMock.mockClear();
    rerender({ loading: false, hasMore: false });
    captured.onRowsRendered?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).not.toHaveBeenCalled();
  });

  it('uses the latest onLoadMore callback inside the scroll fallback', async () => {
    const rows = createRows(120);
    const captured: CapturedList = {};
    const VirtualList = createVirtualList(captured);
    const baseProps = {
      rows,
      logHead: {},
      matchSnippets: {},
      t: t as any,
      onOpen: () => {},
      onReplay: () => {},
      loading: false,
      locale: 'en-US',
      sortBy: 'time' as const,
      sortDir: 'asc' as const,
      onSort: () => {}
    };

    const initialLoadMore = jest.fn();
    const nextLoadMore = jest.fn();

    const view = render(
      <LogsTable
        {...baseProps}
        hasMore={false}
        onLoadMore={initialLoadMore}
        virtualListComponent={VirtualList}
      />
    );

    view.rerender(
      <LogsTable
        {...baseProps}
        hasMore={true}
        onLoadMore={nextLoadMore}
        virtualListComponent={VirtualList}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    const el = captured.outer as HTMLDivElement;
    expect(el).toBeTruthy();
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });

    await act(async () => {
      el.scrollTop = 1000 - 300 - 24;
      fireEvent.scroll(el);
    });

    expect(initialLoadMore).not.toHaveBeenCalled();
    expect(nextLoadMore).toHaveBeenCalled();
  });
});
