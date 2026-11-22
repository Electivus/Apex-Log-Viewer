import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ApexLogRow } from '@alv/protocol/types';
import { LogsTable } from '../components/LogsTable';
import { LOG_ROW_HEIGHT_PX } from '../utils/logsColumns';

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

describe('LogsTable', () => {
  function renderTable({
    rows = createRows(10),
    fullLogSearchEnabled = true,
    hasSearchText = true,
    emptyMessage
  }: {
    rows?: ApexLogRow[];
    fullLogSearchEnabled?: boolean;
    hasSearchText?: boolean;
    emptyMessage?: string;
  }) {
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
        fullLogSearchEnabled={fullLogSearchEnabled}
        hasSearchText={hasSearchText}
        emptyMessage={emptyMessage}
      />
    );
    return view;
  }

  it('gives every row the same fixed height, so nothing is measured', () => {
    renderTable({ rows: createRows(30) });
    expect(LOG_ROW_HEIGHT_PX).toBe(28);
    expect(screen.getAllByRole('row')[1]).toHaveStyle({ height: `${LOG_ROW_HEIGHT_PX}px` });
  });

  it('shows its message where the rows would be', () => {
    renderTable({ rows: [], emptyMessage: 'No logs found.' });
    expect(screen.getByTestId('logs-empty-message')).toHaveTextContent('No logs found.');
    expect(screen.getByText('Operation')).toBeInTheDocument();
  });

  it('shows the Match column while the search has text', () => {
    renderTable({ fullLogSearchEnabled: true, hasSearchText: true });
    expect(screen.queryByText(deprecatedColumnLabel)).toBeNull();
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('leaves the Match column out when the search is empty and brings it back with the next search', () => {
    const view = renderTable({ hasSearchText: false });
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
        fullLogSearchEnabled={true}
        hasSearchText={true}
      />
    );
    expect(screen.getByText('Match')).toBeInTheDocument();
  });

  it('hides both deprecated code unit and match when full log search is disabled', () => {
    renderTable({ fullLogSearchEnabled: false });
    expect(screen.queryByText(deprecatedColumnLabel)).toBeNull();
    expect(screen.queryByText('Match')).toBeNull();
  });

  describe('column widths', () => {
    function renderResizable(widths: Record<string, number>) {
      const state = { config: { ...defaultColumnsConfig, widths } as any, persisted: [] as boolean[] };
      render(
        <LogsTable
          rows={createRows(1)}
          logHead={{}}
          matchSnippets={{}}
          t={t as any}
          onOpen={() => {}}
          onReplay={() => {}}
          locale="en-US"
          sortBy="time"
          sortDir="desc"
          onSort={() => {}}
          columnsConfig={state.config}
          onColumnsConfigChange={(updater: any, options?: { persist?: boolean }) => {
            state.config = updater(state.config);
            state.persisted.push(options?.persist ?? true);
          }}
          fullLogSearchEnabled={false}
          hasSearchText={false}
        />
      );
      return state;
    }

    it('saves a dragged width when the pointer is released', () => {
      const state = renderResizable({});
      fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize User' }), { pointerId: 1, clientX: 0 });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
      });
      expect(state.config.widths.user).toBe(300);
      expect(state.persisted).toEqual([false]);
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
      expect(state.persisted).toEqual([false, true]);
    });

    it('returns a column to its default width on a double click', () => {
      const state = renderResizable({ user: 300, time: 200 });
      fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize User' }));
      expect(state.config.widths).toEqual({ time: 200 });
    });
  });
});
