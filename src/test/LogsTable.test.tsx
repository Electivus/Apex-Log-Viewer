import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
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
  test('loads more when scrolled near end', () => {
    const rows = createRows(20);
    const captured: any = {};
    const VariableSizeList = React.forwardRef<HTMLDivElement, any>((props, ref) => {
      captured.onItemsRendered = props.onItemsRendered;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (typeof props.outerRef === 'function') {
              props.outerRef(el);
            } else if (props.outerRef) {
              props.outerRef.current = el;
            }
          }}
        />
      );
    });
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { VariableSizeList }
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

    const outer = captured.outer as HTMLDivElement;
    outer.scrollTop = 10;
    fireEvent.scroll(outer);
    captured.onItemsRendered({
      overscanStartIndex: 0,
      overscanStopIndex: 0,
      visibleStartIndex: 0,
      visibleStopIndex: rows.length - 1
    });
    assert.equal(loadMore > 0, true);
  });

  test('adjusts overscan based on scroll speed', async () => {
    const rows = createRows(5);
    const captured: any = {};
    const VariableSizeList = React.forwardRef<HTMLDivElement, any>((props, ref) => {
      captured.overscanCount = props.overscanCount;
      return (
        <div
          ref={el => {
            captured.outer = el;
            if (typeof props.outerRef === 'function') {
              props.outerRef(el);
            } else if (props.outerRef) {
              props.outerRef.current = el;
            }
          }}
        />
      );
    });
    const { LogsTable } = proxyquire('../webview/components/LogsTable', {
      'react-window': { VariableSizeList }
    });

    render(
      <LogsTable
        rows={rows}
        logHead={{}}
        t={t}
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
});
