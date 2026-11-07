import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { LogsTable } from '../components/LogsTable';
import { SCROLLBAR_GUTTER } from '../components/table/useVirtualListElement';
import { grid, mountApp } from './customLogsTestKit';

/**
 * Like react-window 2's List: the scroll element is List state, so the handle reports `element: null` on the
 * first commit and a real element only after the List renders again. A parent that read the element once on
 * mount never saw it, and its header stayed put while the rows scrolled (#1262).
 */
jest.mock('react-window', () => {
  const React = require('react');
  return {
    List: function LateElementList({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) {
      const [element, setElement] = React.useState(null);
      React.useImperativeHandle(listRef, () => ({ element, scrollToRow: () => {} }), [element]);
      return React.createElement(
        'div',
        { ref: setElement, 'data-testid': 'virtual-list', style, className },
        Array.from({ length: rowCount }).map((_: unknown, index: number) =>
          React.createElement(
            React.Fragment,
            { key: index },
            rowComponent({
              ...rowProps,
              index,
              style: { height: typeof rowHeight === 'function' ? rowHeight(index) : rowHeight }
            })
          )
        )
      );
    }
  };
});

function scrollBody(body: HTMLElement, left: number) {
  act(() => {
    body.scrollLeft = left;
    fireEvent.scroll(body);
  });
}

describe('table headers', () => {
  it('Logs: the header follows the rows when they scroll horizontally', () => {
    render(
      <LogsTable
        rows={[{ Id: '07L000000000001AAA', StartTime: '2026-11-05T10:00:00.000Z', LogLength: 10 } as any]}
        logHead={{}}
        matchSnippets={{}}
        t={{ columns: {}, open: 'Open', replay: 'Replay' } as any}
        onOpen={() => {}}
        onReplay={() => {}}
        locale="en-US"
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
        columnsConfig={
          {
            order: ['user', 'application', 'operation', 'time', 'duration', 'status', 'size', 'match'],
            visibility: {
              user: true,
              application: true,
              operation: true,
              time: true,
              duration: true,
              status: true,
              size: true,
              match: false
            },
            widths: {}
          } as any
        }
        onColumnsConfigChange={() => {}}
        fullLogSearchEnabled={false}
        hasSearchText={false}
      />
    );
    const body = screen.getByTestId('virtual-list');
    const header = screen.getAllByRole('row')[0]!.parentElement as HTMLElement;

    scrollBody(body, 400);

    expect(header.scrollLeft).toBe(400);
  });

  it('Custom Logs: the header follows the rows when they scroll horizontally', () => {
    mountApp();
    const body = screen.getByTestId('virtual-list');
    const header = grid().querySelector('[role="row"]') as HTMLElement;

    scrollBody(body, 190);

    expect(header.scrollLeft).toBe(190);
  });

  it('reserves the scrollbar gutter on the body and on the header of both tables, so the columns line up', () => {
    mountApp();
    expect(screen.getByTestId('virtual-list').className).toContain(SCROLLBAR_GUTTER);
    expect((grid().querySelector('[role="row"]') as HTMLElement).className).toContain(SCROLLBAR_GUTTER);
  });
});
