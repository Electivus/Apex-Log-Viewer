import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { CustomLogEntryList } from '../components/custom-logs/CustomLogEntryList';
import { SCROLLBAR_GUTTER } from '../components/table/useVirtualListElement';
import { getMessages } from '../i18n';
import { buildEntryColumns } from '../utils/customLogs/entries';
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
              style: {
                height:
                  typeof rowHeight === 'number'
                    ? rowHeight
                    : typeof rowHeight === 'function'
                      ? rowHeight(index)
                      : (rowHeight.getRowHeight(index) ?? rowHeight.getAverageRowHeight())
              }
            })
          )
        )
      );
    }
  };
});

function scrollHorizontally(element: HTMLElement, left: number) {
  act(() => {
    element.scrollLeft = left;
    fireEvent.scroll(element);
  });
}

function mountCustomLogs() {
  const { view } = mountApp();
  return {
    ...view,
    body: screen.getByTestId('virtual-list'),
    header: grid().querySelector('[role="row"]') as HTMLElement
  };
}

function mountEntries() {
  const t = getMessages('en').customLogs;
  const view = render(
    <CustomLogEntryList
      t={t}
      entries={[
        {
          id: 'a025g00000Hk1AbAAJ',
          sequence: 1,
          time: '2026-10-29T23:29:49.000Z',
          level: 'INFO',
          rawLevel: 'INFO',
          message: 'Order synced',
          previewClipped: false,
          system: false,
          presentDetails: [],
          extra: {}
        }
      ]}
      columns={buildEntryColumns({
        labels: t.viewer.columns,
        extra: [],
        payload: [],
        discovered: [],
        hasOrigin: false
      })}
      sort={undefined}
      selectedId={undefined}
      discovered={[]}
      activeColumns={new Set()}
      lockedColumns={new Set()}
      onSort={() => {}}
      onSelect={() => {}}
      onToggleColumn={() => {}}
      onRemoveColumn={() => {}}
    />
  );
  return {
    ...view,
    body: screen.getByTestId('virtual-list'),
    header: screen.getByRole('grid').querySelector('[role="row"]') as HTMLElement
  };
}

describe.each([
  { name: 'Custom Logs', mount: mountCustomLogs },
  { name: 'Custom Log entries', mount: mountEntries }
])('$name table headers', ({ mount }) => {
  it('the header follows the rows when they scroll horizontally', () => {
    const { body, header } = mount();

    scrollHorizontally(body, 400);

    expect(header.scrollLeft).toBe(400);
  });

  it('the rows follow a header scroll after the body has scrolled', () => {
    const { body, header } = mount();

    scrollHorizontally(body, 504);
    expect(header.scrollLeft).toBe(504);

    // Focus on an offscreen header button scrolls the header in the browser. jsdom needs that event supplied.
    scrollHorizontally(header, 904);
    expect(body.scrollLeft).toBe(904);

    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(904);

    scrollHorizontally(header, 120);
    expect(body.scrollLeft).toBe(120);
    fireEvent.scroll(body);
    expect(header.scrollLeft).toBe(120);

    scrollHorizontally(body, 240);
    expect(header.scrollLeft).toBe(240);
    fireEvent.scroll(header);
    expect(body.scrollLeft).toBe(240);
  });

  it('stops synchronizing both scroll containers after unmount', () => {
    const { body, header, unmount } = mount();

    scrollHorizontally(header, 190);
    expect(body.scrollLeft).toBe(190);

    unmount();
    scrollHorizontally(header, 340);
    expect(body.scrollLeft).toBe(190);

    scrollHorizontally(body, 520);
    expect(header.scrollLeft).toBe(340);
  });
});

describe('table headers', () => {
  it('reserves the scrollbar gutter on the body and on the header of both tables, so the columns line up', () => {
    mountApp();
    expect(screen.getByTestId('virtual-list').className).toContain(SCROLLBAR_GUTTER);
    expect((grid().querySelector('[role="row"]') as HTMLElement).className).toContain(SCROLLBAR_GUTTER);
  });
});
