import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
const proxyquire: any = require('proxyquire');
import type { ApexLogRow } from '../shared/types';
import { I18nProvider } from '../webview/i18n';

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


suite('LogsTable', () => {
  test('loads more via onRowsRendered without prior scroll', () => {
    const rows = createRows(30);
    const captured: any = {};
    const List = (props: any) => {
      captured.onRowsRendered = props.onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List }
    });

    let loadMore = 0;
    render(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
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
      </I18nProvider>
    );

    // Without any scroll, being near the end should trigger loadMore
    captured.onRowsRendered({ startIndex: 0, stopIndex: rows.length - 1 });
    assert.equal(loadMore > 0, true);
  });

  test('loads more when scrolled near end', () => {
    const rows = createRows(20);
    const captured: any = {};
    const List = (props: any) => {
      captured.onRowsRendered = props.onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List }
    });

    let loadMore = 0;
    render(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
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
      </I18nProvider>
    );

    const outer = captured.outer as HTMLDivElement;
    outer.scrollTop = 10;
    fireEvent.scroll(outer);
    captured.onRowsRendered({ startIndex: 0, stopIndex: rows.length - 1 });
    assert.equal(loadMore > 0, true);
  });

  test('adjusts overscan based on scroll speed', async () => {
    const rows = createRows(5);
    const captured: any = {};
    const List = (props: any) => {
      captured.overscanCount = props.overscanCount;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List }
    });

    render(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
          onOpen={() => {}}
          onReplay={() => {}}
          loading={false}
          locale="en-US"
          hasMore={false}
          onLoadMore={() => {}}
          sortBy="time"
          sortDir="asc"
          onSort={() => {}}
        />
      </I18nProvider>
    );

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
    await new Promise(r => setTimeout(r, 0));
    assert.equal(captured.overscanCount > 8, true);

    await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(captured.overscanCount, 8);
    (performance as any).now = originalNow;
  });

  test('loads more when scrolled to bottom (safety net)', () => {
    const rows = createRows(200);
    const captured: any = {};
    const List = (props: any) => {
      return (
        <div
          ref={el => {
            captured.outer = el as HTMLDivElement;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List }
    });

    let loadMore = 0;
    render(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
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
      </I18nProvider>
    );

    const el = captured.outer as HTMLDivElement;
    // Simulate dimensions so remaining <= defaultRowHeight*2 (64px)
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    el.scrollTop = 1000 - 300 - 20; // remaining = 20

    const originalNow = performance.now.bind(performance);
    (performance as any).now = () => 1000; // pass the debounce > 300ms

    fireEvent.scroll(el);

    assert.equal(loadMore > 0, true);
    (performance as any).now = originalNow;
  });

  test('does not load when loading or hasMore=false', () => {
    const rows = createRows(50);
    const captured: any = {};
    const List = (props: any) => {
      captured.onRowsRendered = props.onRowsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (props.listRef) {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof props.listRef === 'function') props.listRef(api);
              else props.listRef.current = api;
            }
          }}
        />
      );
    };
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { List }
    });

    let loadMore = 0;
    const { rerender } = render(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
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
      </I18nProvider>
    );

    captured.onRowsRendered({ startIndex: 0, stopIndex: rows.length - 1 });
    assert.equal(loadMore, 0);

    rerender(
      <I18nProvider locale="en">
        <LogsTable
          rows={rows}
          logHead={{}}
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
      </I18nProvider>
    );
    captured.onRowsRendered({ startIndex: 0, stopIndex: rows.length - 1 });
    assert.equal(loadMore, 0);
  });
});
