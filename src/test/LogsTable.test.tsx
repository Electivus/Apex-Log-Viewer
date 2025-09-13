import assert from 'assert/strict';
import React from 'react';
import { render } from '@testing-library/react';
const proxyquire: any = require('proxyquire');
import type { ApexLogRow } from '../shared/types';

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

suite('LogsTable', () => {
  function createStubs(captured: any) {
    const List = (props: any) => {
      captured.onRowsRendered = props.onRowsRendered;
      return (
        <div
          ref={el => {
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const InfiniteLoader = (props: any) => {
      return props.children({
        onItemsRendered: (info: any) => {
          const start = Math.max(0, info.overscanStopIndex - props.threshold + 1);
          for (let i = start; i <= info.overscanStopIndex && i < props.itemCount; i++) {
            if (!props.isItemLoaded(i)) {
              props.loadMoreItems();
              break;
            }
          }
        },
        ref: () => {}
      });
    };
    return { List, InfiniteLoader };
  }

  test('slow scroll triggers load more near end', () => {
    const rows = createRows(30);
    const captured: any = {};
    const { List, InfiniteLoader } = createStubs(captured);
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List },
      'react-window-infinite-loader': { default: InfiniteLoader }
    });

    let loadMore = 0;
    render(
      <LogsTable
        rows={rows}
        logHead={{}}
        t={t}
        onOpen={() => {}}
        onReplay={() => {}}
        loading={false}
        locale="en-US"
        hasMore={true}
        onLoadMore={() => loadMore++}
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
      />
    );

    for (let i = 0; i < rows.length; i += 5) {
      captured.onRowsRendered({ startIndex: i, stopIndex: Math.min(rows.length - 1, i + 4) });
    }
    captured.onRowsRendered({ startIndex: rows.length - 5, stopIndex: rows.length - 1 });
    assert.equal(loadMore > 0, true);
  });

  test('fast scroll triggers load more near end', () => {
    const rows = createRows(30);
    const captured: any = {};
    const { List, InfiniteLoader } = createStubs(captured);
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List },
      'react-window-infinite-loader': { default: InfiniteLoader }
    });

    let loadMore = 0;
    render(
      <LogsTable
        rows={rows}
        logHead={{}}
        t={t}
        onOpen={() => {}}
        onReplay={() => {}}
        loading={false}
        locale="en-US"
        hasMore={true}
        onLoadMore={() => loadMore++}
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
      />
    );

    captured.onRowsRendered({ startIndex: rows.length - 5, stopIndex: rows.length - 1 });
    assert.equal(loadMore > 0, true);
  });

  test('does not load when loading or hasMore=false', () => {
    const rows = createRows(20);
    const captured: any = {};
    const { List, InfiniteLoader } = createStubs(captured);
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List },
      'react-window-infinite-loader': { default: InfiniteLoader }
    });

    let loadMore = 0;
    const { rerender } = render(
      <LogsTable
        rows={rows}
        logHead={{}}
        t={t}
        onOpen={() => {}}
        onReplay={() => {}}
        loading={true}
        locale="en-US"
        hasMore={true}
        onLoadMore={() => loadMore++}
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
      />
    );

    captured.onRowsRendered({ startIndex: rows.length - 5, stopIndex: rows.length - 1 });
    assert.equal(loadMore, 0);

    rerender(
      <LogsTable
        rows={rows}
        logHead={{}}
        t={t}
        onOpen={() => {}}
        onReplay={() => {}}
        loading={false}
        locale="en-US"
        hasMore={false}
        onLoadMore={() => loadMore++}
        sortBy="time"
        sortDir="asc"
        onSort={() => {}}
      />
    );
    captured.onRowsRendered({ startIndex: rows.length - 5, stopIndex: rows.length - 1 });
    assert.equal(loadMore, 0);
  });
});

