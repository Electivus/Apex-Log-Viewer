import React from 'react';
import { fireEvent, render } from '@testing-library/react';

import type { ApexLogRow } from '../shared/types';
import { LogsTable } from '../components/LogsTable';

jest.mock('react-window', () => ({
  List: jest.fn(() => null)
}));

const { List } = require('react-window') as { List: jest.Mock };

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
    status: 'Status',
    codeUnitStarted: 'Code Unit',
    size: 'Size'
  }
};

describe('LogsTable', () => {
  afterEach(() => {
    List.mockReset();
  });

  function renderTable({
    rows = createRows(10),
    hasMore = true,
    loading = false,
    captured
  }: {
    rows?: ApexLogRow[];
    hasMore?: boolean;
    loading?: boolean;
    captured: Record<string, unknown>;
  }) {
    const loadMoreMock = jest.fn();
    const baseProps = {
      rows,
      logHead: {},
      t: t as any,
      onOpen: () => {},
      onReplay: () => {},
      loading,
      locale: 'en-US',
      hasMore,
      sortBy: 'time',
      sortDir: 'asc',
      onSort: () => {}
    };
    const view = render(<LogsTable {...baseProps} onLoadMore={loadMoreMock} />);
    return {
      loadMoreMock,
      rerender: (next: Partial<typeof baseProps>) =>
        view.rerender(<LogsTable {...baseProps} {...next} onLoadMore={loadMoreMock} />)
    };
  }

  it('requests more data via onRowsRendered before any scroll occurs', () => {
    const rows = createRows(30);
    const captured: Record<string, unknown> = {};
    List.mockImplementation(({ listRef, onRowsRendered }: any) => {
      captured.onRowsRendered = onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement | null;
            const api = { element: el, scrollToRow: () => {} };
            if (typeof listRef === 'function') {
              listRef(api);
            } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
              (listRef as { current: unknown }).current = api;
            }
          }}
        />
      );
    });

    const { loadMoreMock } = renderTable({ rows, captured });
    const handler = captured.onRowsRendered as ((args: { startIndex: number; stopIndex: number }) => void) | undefined;
    expect(handler).toBeDefined();
    handler?.({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).toHaveBeenCalled();
  });

  it('requests more data after user scrolls near the end', () => {
    const rows = createRows(20);
    const captured: Record<string, unknown> = {};
    List.mockImplementation(({ listRef, onRowsRendered }: any) => {
      captured.onRowsRendered = onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement | null;
            const api = { element: el, scrollToRow: () => {} };
            if (typeof listRef === 'function') {
              listRef(api);
            } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
              (listRef as { current: unknown }).current = api;
            }
          }}
        />
      );
    });

    const { loadMoreMock } = renderTable({ rows, captured });
    const outer = captured.outer as HTMLDivElement;
    outer.scrollTop = 10;
    fireEvent.scroll(outer);
    const handler = captured.onRowsRendered as (args: { startIndex: number; stopIndex: number }) => void;
    handler({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).toHaveBeenCalled();
  });

  it('adjusts overscan while scrolling quickly', async () => {
    const captured: Record<string, unknown> = {};
    List.mockImplementation(({ listRef, overscanCount }: any) => {
      captured.overscanCount = overscanCount;
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement | null;
            const api = { element: el, scrollToRow: () => {} };
            if (typeof listRef === 'function') {
              listRef(api);
            } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
              (listRef as { current: unknown }).current = api;
            }
          }}
        />
      );
    });

    renderTable({ rows: createRows(5), hasMore: false, captured });
    const outer = captured.outer as HTMLDivElement;
    const originalNow = performance.now.bind(performance);
    let now = 0;
    (performance as any).now = () => now;

    outer.scrollTop = 50;
    fireEvent.scroll(outer);
    now += 20;
    outer.scrollTop = 100;
    fireEvent.scroll(outer);
    now += 20;
    outer.scrollTop = 200;
    fireEvent.scroll(outer);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured.overscanCount as number).toBeGreaterThan(8);

    await new Promise(resolve => setTimeout(resolve, 250));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(captured.overscanCount).toBe(8);
    (performance as any).now = originalNow;
  });

  it('uses bottom proximity as a fallback trigger for pagination', () => {
    const captured: Record<string, unknown> = {};
    List.mockImplementation(({ listRef, overscanCount }: any) => {
      captured.overscanCount = overscanCount;
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement | null;
            const api = { element: el, scrollToRow: () => {} };
            if (typeof listRef === 'function') {
              listRef(api);
            } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
              (listRef as { current: unknown }).current = api;
            }
          }}
        />
      );
    });

    const { loadMoreMock } = renderTable({ rows: createRows(200), captured });
    const el = captured.outer as HTMLDivElement;
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    el.scrollTop = 1000 - 300 - 20;

    const originalNow = performance.now.bind(performance);
    (performance as any).now = () => 1000;

    fireEvent.scroll(el);
    expect(loadMoreMock).toHaveBeenCalled();
    (performance as any).now = originalNow;
  });

  it('avoids loading more when already loading or when hasMore is false', () => {
    const rows = createRows(50);
    const captured: Record<string, unknown> = {};
    List.mockImplementation(({ listRef, onRowsRendered }: any) => {
      captured.onRowsRendered = onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement | null;
            const api = { element: el, scrollToRow: () => {} };
            if (typeof listRef === 'function') {
              listRef(api);
            } else if (listRef && typeof listRef === 'object' && 'current' in listRef) {
              (listRef as { current: unknown }).current = api;
            }
          }}
        />
      );
    });

    const { loadMoreMock, rerender } = renderTable({ rows, loading: true, hasMore: true, captured });
    const handler = captured.onRowsRendered as (args: { startIndex: number; stopIndex: number }) => void;
    handler({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).not.toHaveBeenCalled();

    loadMoreMock.mockClear();
    rerender({ loading: false, hasMore: false });
    const nextHandler = captured.onRowsRendered as (args: { startIndex: number; stopIndex: number }) => void;
    nextHandler({ startIndex: 0, stopIndex: rows.length - 1 });
    expect(loadMoreMock).not.toHaveBeenCalled();
  });
});
