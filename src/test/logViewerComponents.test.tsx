import assert from 'assert/strict';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const proxyquire: any = require('proxyquire');

import type { LogCategory, ParsedLogEntry } from '../webview/utils/logViewerParser';
import { LogViewerFilters } from '../webview/components/log-viewer/LogViewerFilters';
import { LogViewerHeader } from '../webview/components/log-viewer/LogViewerHeader';
import { LogViewerStatusBar } from '../webview/components/log-viewer/LogViewerStatusBar';
import { LogEntryRow } from '../webview/components/log-viewer/LogEntryRow';

suite('Log viewer components', () => {
  suite('LogViewerHeader', () => {
    test('handles search updates and disables controls', () => {
      const changes: string[] = [];
      const viewCalls: number[] = [];
      const { unmount } = render(
        <LogViewerHeader
          fileName="MyLog.log"
          search=""
          onSearchChange={value => changes.push(value)}
          onViewRaw={() => viewCalls.push(1)}
          disabled
        />
      );

      const search = screen.getByPlaceholderText('Search entries…') as HTMLInputElement;
      assert.equal(search.disabled, true, 'search input disabled when prop set');
      const disabledButton = screen.getByRole('button', { name: 'View Raw' });
      assert.equal(disabledButton.hasAttribute('disabled'), true, 'view raw button disabled');
      unmount();

      const enabledChanges: string[] = [];
      const enabledView: number[] = [];
      render(
        <LogViewerHeader
          fileName=""
          search="debug"
          onSearchChange={value => enabledChanges.push(value)}
          onViewRaw={() => enabledView.push(1)}
        />
      );
      screen.getByText('Debug Log Analysis');

      const input = screen.getByDisplayValue('debug');
      fireEvent.change(input, { target: { value: 'fatal error' } });
      assert.equal(enabledChanges[0], 'fatal error');

      fireEvent.click(screen.getByText('View Raw'));
      assert.equal(enabledView.length, 1, 'view raw callback invoked');
    });
  });

  suite('LogViewerFilters', () => {
    test('toggles filters and formats counts with locale', () => {
      const calls: Array<string> = [];
      render(
        <LogViewerFilters
          active="all"
          onChange={next => calls.push(next)}
          counts={{ total: 1234, debug: 12, soql: 5, dml: 3 }}
          locale="en-US"
        />
      );

      fireEvent.click(screen.getByText('Debug Only'));
      assert.equal(calls[0], 'debug');

      fireEvent.click(screen.getByText('SOQL'));
      assert.equal(calls[1], 'soql');

      const showing = screen.getByText(/entries$/);
      assert.equal(showing.textContent?.includes('1,234 entries'), true, 'locale formatting applied');
    });

    test('falls back to default locale when Number.toLocaleString throws', () => {
      const original = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function mocked(locale?: string) {
        if (locale === 'zz-ZZ') {
          throw new Error('unsupported locale');
        }
        return original.call(this, locale as any);
      };
      try {
        render(
          <LogViewerFilters
            active="debug"
            onChange={() => {}}
            counts={{ total: 999, debug: 456, soql: 0, dml: 0 }}
            locale="zz-ZZ"
          />
        );
        const badge = screen.getByText(/entries/);
        assert.equal(/456/.test(badge.textContent ?? ''), true, 'fallback renders default locale value');
      } finally {
        Number.prototype.toLocaleString = original;
      }
    });
  });

  suite('LogViewerStatusBar', () => {
    test('renders metadata and formatted values', () => {
      render(
        <LogViewerStatusBar
          counts={{ total: 2048, debug: 20, soql: 10, dml: 4 }}
          locale="en-US"
          metadata={{ sizeBytes: 1536, modifiedAt: '2025-09-21T17:30:00.000Z' }}
        />
      );

      screen.getByText('Total Lines: 2,048');
      screen.getByText('Debug Statements: 20');
      screen.getByText('SOQL Queries: 10');
      screen.getByText('DML Operations: 4');
      screen.getByText('Size: 1.5 KB');
      const updated = screen.getByText(/Updated:/);
      assert.equal(updated.textContent?.includes('Updated:'), true);
      screen.getByText('Ready');
    });

    test('omits updated timestamp when invalid and recovers from locale failure', () => {
      const original = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function mocked(locale?: string) {
        if (locale === 'bad-locale') {
          throw new Error('boom');
        }
        return original.call(this, locale as any);
      };
      try {
        render(
          <LogViewerStatusBar
            counts={{ total: 12, debug: 1, soql: 2, dml: 3 }}
            locale="bad-locale"
            metadata={{ sizeBytes: 512, modifiedAt: 'not-a-date' }}
          />
        );
        assert.equal(screen.queryByText(/Updated:/), null, 'invalid date hidden');
        screen.getByText('Size: 512 B');
      } finally {
        Number.prototype.toLocaleString = original;
      }
    });
  });

  suite('LogEntryRow', () => {
    const baseEntry: ParsedLogEntry = {
      id: 1,
      timestamp: '12:00:00.000',
      type: 'USER_DEBUG',
      message: 'Debug message',
      raw: 'raw line',
      category: 'debug',
      details: 'Context info'
    };

    test('measures row and applies highlight styling', () => {
      const measured: number[] = [];
      const { container } = render(<LogEntryRow entry={baseEntry} highlighted onMeasured={value => measured.push(value)} />);
      const row = container.firstElementChild as HTMLDivElement;
      assert.ok(row?.className.includes('bg-sky-500/10'), 'highlight class applied');
      assert.equal(measured.length > 0, true, 'measurement callback invoked');
      assert.ok(screen.getByText('Context info'));
    });

    (['debug', 'soql', 'dml', 'code', 'limit', 'system', 'other'] as LogCategory[]).forEach(category => {
      test(`applies visuals for ${category} entries`, () => {
        const entry = { ...baseEntry, category, type: category.toUpperCase(), details: undefined };
        render(<LogEntryRow entry={entry} highlighted={false} onMeasured={() => {}} />);
        const badge = screen.getByText(entry.type);
        assert.equal(typeof badge.className, 'string');
        assert.equal(badge.className.length > 0, true);
      });
    });
  });

  suite('LogEntryList', () => {
    test('renders empty state when no entries', () => {
      const { LogEntryList } = require('../webview/components/log-viewer/LogEntryList');
      render(<LogEntryList entries={[]} />);
      screen.getByText('No entries match the current filters.');
    });

    test('renders rows, measures height, and forwards highlight category', async () => {
      const entries: ParsedLogEntry[] = [
        {
          id: 0,
          timestamp: '00:00',
          type: 'USER_DEBUG',
          message: 'Debug line',
          raw: 'raw',
          category: 'debug'
        },
        {
          id: 1,
          timestamp: '00:01',
          type: 'SOQL',
          message: 'Query line',
          raw: 'raw',
          category: 'soql'
        }
      ];

      const captured: { measured: number[]; highlighted: Record<number, boolean> } = {
        measured: [],
        highlighted: {}
      };

      const List = (props: any) => {
        const nodes = Array.from({ length: props.rowCount }).map((_, index) => (
          <div key={index}>
            {props.rowComponent({ ...props.rowProps, index, style: { height: props.rowHeight(index) } })}
          </div>
        ));
        return (
          <div
            data-testid="virtual-list"
            ref={el => {
              if (props.listRef) {
                const api = { element: el };
                if (typeof props.listRef === 'function') props.listRef(api);
                else props.listRef.current = api;
              }
            }}
          >
            {nodes}
          </div>
        );
      };

      const StubRow = ({ entry, highlighted, onMeasured }: any) => {
        React.useEffect(() => {
          const value = 72 + entry.id;
          captured.measured.push(value);
          onMeasured(value);
        }, [entry, onMeasured]);
        captured.highlighted[entry.id] = highlighted;
        return <div data-testid={`row-${entry.id}`}>{entry.message}</div>;
      };

      const { LogEntryList } = proxyquire('../webview/components/log-viewer/LogEntryList', {
        'react-window': { List },
        './LogEntryRow': { LogEntryRow: StubRow }
      });

      render(<LogEntryList entries={entries} highlightCategory="debug" />);

      await waitFor(() => {
        assert.equal(captured.highlighted[0], true);
        assert.equal(captured.highlighted[1], false);
      });

      await waitFor(() => {
        assert.equal(captured.measured.length > 0, true);
      });
    });
  });
});
