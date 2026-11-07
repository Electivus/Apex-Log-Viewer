import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { List } from 'react-window';
import type { ApexLogRow } from '@alv/protocol/types';
import { LogsTable } from '../components/LogsTable';
import { LOG_ROW_HEIGHT_PX } from '../utils/logsColumns';

type CapturedList = {
  outer?: HTMLDivElement | null;
  onRowsRendered?: (args: { startIndex: number; stopIndex: number }) => void;
  overscanCount?: number;
  rowHeight?: unknown;
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
    size: 'Size',
    match: 'Match'
  }
};

const deprecatedColumnLabel = ['Code', 'Unit'].join(' ');

const defaultColumnsConfig = {
  order: ['user', 'application', 'operation', 'time', 'duration', 'status', 'size', 'match'],
  visibility: {
    user: true,
    application: true,
    operation: true,
    time: true,
    duration: true,
    status: true,
    size: true,
    match: true
  },
  widths: {}
} as const;

function createVirtualList(captured: CapturedList): typeof List {
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
    captured.rowHeight = rowHeight;
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
          <div key={index}>{rowComponent({ ...rowProps, index, style: { height: rowHeight } })}</div>
        ))}
      </div>
    );
  } as unknown as typeof List;
}

describe('LogsTable', () => {
  function renderTable({
    rows = createRows(10),
    captured,
    fullLogSearchEnabled = true,
    hasSearchText = true,
    emptyMessage
  }: {
    rows?: ApexLogRow[];
    captured: CapturedList;
    fullLogSearchEnabled?: boolean;
    hasSearchText?: boolean;
    emptyMessage?: string;
  }) {
    const virtualList = createVirtualList(captured);
    const baseProps = {
      rows,
      logHead: {},
      matchSnippets: {},
      t: t as any,
      onOpen: () => {},
      onReplay: () => {},
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
        hasSearchText={hasSearchText}
        emptyMessage={emptyMessage}
      />
    );
    return view;
  }

  it('does not provide pagination hooks via onRowsRendered', () => {
    const captured: CapturedList = {};
    renderTable({ rows: createRows(30), captured });
    expect(captured.onRowsRendered).toBeUndefined();
  });

  it('gives every row the same fixed height, so nothing is measured', () => {
    const captured: CapturedList = {};
    renderTable({ rows: createRows(30), captured });
    expect(captured.rowHeight).toBe(LOG_ROW_HEIGHT_PX);
    expect(LOG_ROW_HEIGHT_PX).toBe(28);
  });

  it('fills the height its parent gives it instead of reading the window', () => {
    const captured: CapturedList = {};
    renderTable({ captured });
    expect(captured.outer?.style.height).toBe('100%');
  });

  it('shows its message where the rows would be', () => {
    const captured: CapturedList = {};
    renderTable({ rows: [], captured, emptyMessage: 'No logs found.' });
    expect(screen.getByTestId('logs-empty-message')).toHaveTextContent('No logs found.');
    expect(screen.getByText('Operation')).toBeInTheDocument();
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

  it('shows the Match column while the search has text', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: true, hasSearchText: true });
    expect(screen.queryByText(deprecatedColumnLabel)).toBeNull();
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('leaves the Match column out when the search is empty and brings it back with the next search', () => {
    const captured: CapturedList = {};
    const view = renderTable({ captured, hasSearchText: false });
    expect(screen.queryByText('Match')).toBeNull();
    view.rerender(
      <LogsTable
        rows={createRows(10)}
        logHead={{}}
        matchSnippets={{}}
        t={t as any}
        onOpen={() => {}}
        onReplay={() => {}}
        locale="en-US"
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
        columnsConfig={defaultColumnsConfig as any}
        onColumnsConfigChange={() => {}}
        virtualListComponent={createVirtualList(captured)}
        fullLogSearchEnabled={true}
        hasSearchText={true}
      />
    );
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('hides both deprecated code unit and match when full log search is disabled', () => {
    const captured: CapturedList = {};
    renderTable({ captured, fullLogSearchEnabled: false });
    expect(screen.queryByText(deprecatedColumnLabel)).toBeNull();
    expect(screen.queryByText('Match')).toBeNull();
  });
});
