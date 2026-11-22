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

  describe('the body of the grid', () => {
    function scrollTo(scroller: HTMLElement, top: number) {
      scroller.scrollTop = top;
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    }

    it('renders only the rows near the viewport of a long list', () => {
      renderTable({ rows: createRows(500) });
      const rendered = screen.getAllByRole('row').length - 1;
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(100);
    });

    it('keeps the header and rows in one scroller sharing one column template, so they stay aligned', () => {
      const { container } = renderTable({ rows: createRows(5) });
      const surface = container.querySelector('.overflow-auto') as HTMLElement;
      const [header, firstRow] = screen.getAllByRole('row') as [HTMLElement, HTMLElement];
      expect(surface).toContainElement(header);
      expect(surface).toContainElement(firstRow);
      expect(header.style.gridTemplateColumns).not.toBe('');
      expect(firstRow.style.gridTemplateColumns).toBe(header.style.gridTemplateColumns);
    });

    it('fills its parent with the scroller', () => {
      const { container } = renderTable({ rows: createRows(5) });
      const surface = container.querySelector('.overflow-auto') as HTMLElement;
      expect(surface.className).toContain('absolute');
      expect(surface.className).toContain('inset-0');
      expect(surface.parentElement?.className).toContain('flex-1');
    });

    it('reserves room under the sticky header when a focused row is scrolled into view', () => {
      const { container } = renderTable({ rows: createRows(5) });
      const surface = container.querySelector('.overflow-auto') as HTMLElement;
      expect(surface.className).toContain('scroll-pt-[29px]');
    });

    it('renders extra rows while scrolling fast and returns to the idle amount once scrolling stops', () => {
      jest.useFakeTimers();
      try {
        let now = 0;
        const perf = jest.spyOn(performance, 'now').mockImplementation(() => now);
        const { container } = renderTable({ rows: createRows(500) });
        const surface = container.querySelector('.overflow-auto') as HTMLElement;
        const count = () => screen.getAllByRole('row').length;
        const base = count();
        for (const [dt, dy] of [
          [20, 10], // slow
          [20, 30], // > 0.4 px/ms
          [20, 60], // > 1 px/ms
          [20, 100], // > 2 px/ms
          [20, 100]
        ] as [number, number][]) {
          now += dt;
          scrollTo(surface, surface.scrollTop + dy);
        }
        const fast = count();
        expect(fast).toBeGreaterThan(base);
        act(() => {
          jest.advanceTimersByTime(300);
        });
        expect(count()).toBe(base);
        perf.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('user actions', () => {
    function renderWith(handlers: { onSort?: any; onOpen?: any; onReplay?: any }) {
      return render(
        <LogsTable
          rows={createRows(3)}
          logHead={{}}
          matchSnippets={{}}
          t={t as any}
          onOpen={handlers.onOpen ?? (() => {})}
          onReplay={handlers.onReplay ?? (() => {})}
          locale="en-US"
          sortBy="time"
          sortDir="desc"
          onSort={handlers.onSort ?? (() => {})}
          columnsConfig={defaultColumnsConfig as any}
          onColumnsConfigChange={() => {}}
          fullLogSearchEnabled={false}
          hasSearchText={false}
        />
      );
    }

    it('sorts by the column whose header is clicked and marks the active sort', () => {
      const onSort = jest.fn();
      renderWith({ onSort });
      fireEvent.click(screen.getByText('Operation'));
      expect(onSort).toHaveBeenCalledWith('operation');
      expect(document.querySelector('[aria-sort="descending"]')).not.toBeNull();
    });

    it('opens and replays the log of the row whose buttons are used', () => {
      const onOpen = jest.fn();
      const onReplay = jest.fn();
      renderWith({ onOpen, onReplay });
      fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[1]!);
      expect(onOpen).toHaveBeenCalledWith('1');
      fireEvent.click(screen.getAllByRole('button', { name: 'Replay' })[2]!);
      expect(onReplay).toHaveBeenCalledWith('2');
    });

    it('does not shrink a column below its minimum when dragged narrower', () => {
      const widths: number[] = [];
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
          columnsConfig={defaultColumnsConfig as any}
          onColumnsConfigChange={(updater: any) => widths.push(updater(defaultColumnsConfig).widths.user)}
          fullLogSearchEnabled={false}
          hasSearchText={false}
        />
      );
      fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize User' }), { pointerId: 1, clientX: 500 });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0 }));
      });
      expect(widths[0]).toBe(130);
    });
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
