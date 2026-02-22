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

const defaultColumnsConfig = {
  order: [
    'user',
    'application',
    'operation',
    'time',
    'duration',
    'status',
    'codeUnit',
    'size',
    'match'
  ],
  visibility: {
    user: true,
    application: true,
    operation: true,
    time: true,
    duration: true,
    status: true,
    codeUnit: true,
    size: true,
    match: true
  },
  widths: {}
} as const;

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
    loading = false,
    captured,
    fullLogSearchEnabled = true
  }: {
    rows?: ApexLogRow[];
    loading?: boolean;
    captured: CapturedList;
    fullLogSearchEnabled?: boolean;
  }) {
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
      sortBy: 'time' as const,
      sortDir: 'asc' as const,
      onSort: () => {},
      columnsConfig: defaultColumnsConfig as any,
      onColumnsConfigChange: () => {}
    };
    const view = render(
      <LogsTable
        {...baseProps}
        virtualListComponent={virtualList}
        fullLogSearchEnabled={fullLogSearchEnabled}
      />
    );
    return {
      rerender: (next: Partial<typeof baseProps> & { fullLogSearchEnabled?: boolean }) =>
        view.rerender(
          <LogsTable
            {...baseProps}
            {...next}
            virtualListComponent={virtualList}
            fullLogSearchEnabled={next.fullLogSearchEnabled ?? fullLogSearchEnabled}
          />
        )
    };
  }

  it('does not provide pagination hooks via onRowsRendered', () => {
    const captured: CapturedList = {};
    renderTable({ rows: createRows(30), captured });
    expect(captured.onRowsRendered).toBeUndefined();
  });

  it('adjusts overscan while scrolling quickly', async () => {
    const captured: CapturedList = {};
    renderTable({ rows: createRows(5), captured });
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

  it('shows match column while keeping code unit when full log search is enabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: true });
    expect(screen.getByText('Code Unit')).toBeInTheDocument();
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('shows code unit column and hides match when full log search is disabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: false });
    expect(screen.getByText('Code Unit')).toBeInTheDocument();
    expect(screen.queryByText('Match')).toBeNull();
  });
});
