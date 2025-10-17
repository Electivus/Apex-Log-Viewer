import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { LogCategory, ParsedLogEntry } from '../utils/logViewerParser';
import { LogViewerFilters } from '../components/log-viewer/LogViewerFilters';
import { LogViewerHeader } from '../components/log-viewer/LogViewerHeader';
import { LogViewerStatusBar } from '../components/log-viewer/LogViewerStatusBar';
import { LogEntryRow } from '../components/log-viewer/LogEntryRow';
import { LogEntryList } from '../components/log-viewer/LogEntryList';

describe('Log viewer components', () => {
  describe('LogViewerHeader', () => {
    it('handles search updates, disables controls, and exposes navigation', () => {
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
      expect(search.disabled).toBe(true);
      const disabledButton = screen.getByRole('button', { name: 'View Raw' });
      expect(disabledButton).toBeDisabled();
      unmount();

      const enabledChanges: string[] = [];
      const enabledView: number[] = [];
      const nextCalls: number[] = [];
      const prevCalls: number[] = [];
      render(
        <LogViewerHeader
          fileName=""
          search="debug"
          onSearchChange={value => enabledChanges.push(value)}
          onViewRaw={() => enabledView.push(1)}
          matchCount={2}
          activeMatchIndex={1}
          onNextMatch={() => nextCalls.push(1)}
          onPreviousMatch={() => prevCalls.push(1)}
        />
      );
      screen.getByText('Debug Log Analysis');

      const input = screen.getByDisplayValue('debug');
      fireEvent.change(input, { target: { value: 'fatal error' } });
      expect(enabledChanges[0]).toBe('fatal error');

      fireEvent.click(screen.getByText('View Raw'));
      expect(enabledView).toHaveLength(1);

      // Navigation controls show match counts and are enabled
      screen.getByText('2/2');
      const prev = screen.getByLabelText('Previous match');
      const next = screen.getByLabelText('Next match');
      expect(prev).not.toBeDisabled();
      expect(next).not.toBeDisabled();
      fireEvent.click(prev);
      fireEvent.click(next);
      expect(prevCalls).toHaveLength(1);
      expect(nextCalls).toHaveLength(1);

      fireEvent.keyDown(input, { key: 'Enter' });
      expect(nextCalls).toHaveLength(2);
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(prevCalls).toHaveLength(2);
    });
  });

  describe('LogViewerFilters', () => {
    it('toggles filters and formats counts with locale', () => {
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
      expect(calls[0]).toBe('debug');

      fireEvent.click(screen.getByText('SOQL'));
      expect(calls[1]).toBe('soql');

      const showing = screen.getByText(/entries$/);
      expect(showing.textContent?.includes('1,234 entries')).toBe(true);
    });

    it('falls back to default locale when Number.toLocaleString throws', () => {
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
        expect(/456/.test(badge.textContent ?? '')).toBe(true);
      } finally {
        Number.prototype.toLocaleString = original;
      }
    });
  });

  describe('LogViewerStatusBar', () => {
    it('renders metadata and formatted values', () => {
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
      expect(screen.getByText(/Updated:/)).toHaveTextContent('Updated:');
      screen.getByText('Ready');
    });

    it('omits updated timestamp when invalid and recovers from locale failure', () => {
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
        expect(screen.queryByText(/Updated:/)).toBeNull();
        screen.getByText('Size: 512 B');
      } finally {
        Number.prototype.toLocaleString = original;
      }
    });
  });

  describe('LogEntryRow', () => {
    const baseEntry: ParsedLogEntry = {
      id: 1,
      timestamp: '12:00:00.000',
      type: 'USER_DEBUG',
      message: 'Debug message',
      raw: 'raw line',
      category: 'debug',
      details: 'Context info'
    };

    it('measures row and applies highlight styling', () => {
      const measured: number[] = [];
      const { container } = render(<LogEntryRow entry={baseEntry} highlighted onMeasured={value => measured.push(value)} />);
      const row = container.firstElementChild as HTMLDivElement | null;
      expect(row?.className).toContain('bg-sky-500/10');
      expect(measured.length).toBeGreaterThan(0);
      expect(screen.getByText('Context info')).toBeInTheDocument();
    });

    it.each(['debug', 'soql', 'dml', 'code', 'limit', 'system', 'other'] as LogCategory[])(
      'applies visuals for %s entries',
      category => {
        const entry = { ...baseEntry, category, type: category.toUpperCase(), details: undefined };
        render(<LogEntryRow entry={entry} highlighted={false} onMeasured={() => {}} />);
        const badge = screen.getByText(entry.type);
        expect(typeof badge.className).toBe('string');
        expect(badge.className.length).toBeGreaterThan(0);
      }
    );

    it('highlights matches and active match tokens', () => {
      render(
        <LogEntryRow
          entry={baseEntry}
          highlighted={false}
          isMatch
          isActiveMatch
          searchTerm="debug"
          onMeasured={() => {}}
        />
      );
      const candidates = screen.getAllByText(/Debug/i);
      const mark = candidates.find(node => node.tagName === 'MARK');
      expect(mark).toBeDefined();
      const highlightedRow = document.querySelector('.ring-1');
      expect(highlightedRow).not.toBeNull();
    });
  });

  describe('LogEntryList', () => {
    it('renders empty state when no entries', () => {
      render(<LogEntryList entries={[]} />);
      screen.getByText('No entries match the current filters.');
    });

    it('renders rows, measures height, and forwards highlight category', async () => {
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

      const VirtualList = ({ rowCount, rowHeight, rowComponent, rowProps, listRef }: any) => {
        const rows = Array.from({ length: rowCount }).map((_, index) => {
          const rendered = rowComponent({ ...rowProps, index, style: { height: rowHeight(index) } });
          return <React.Fragment key={index}>{rendered}</React.Fragment>;
        });
        return (
          <div
            data-testid="virtual-list"
            ref={el => {
              const api = { element: el, scrollToRow: () => {} };
              if (typeof listRef === 'function') {
                listRef(api);
              } else if (listRef && 'current' in listRef) {
                (listRef as { current: unknown }).current = api;
              }
            }}
          >
            {rows}
          </div>
        );
      };

      const StubRow = ({ entry, highlighted, onMeasured, isMatch, isActiveMatch }: any) => {
        React.useEffect(() => {
          const value = 72 + entry.id;
          captured.measured.push(value);
          onMeasured(value);
        }, [entry, onMeasured]);
        captured.highlighted[entry.id] = highlighted;
        captured.highlighted[`${entry.id}-match`] = isMatch;
        captured.highlighted[`${entry.id}-active`] = isActiveMatch;
        return <div data-testid={`row-${entry.id}`}>{entry.message}</div>;
      };

      render(
        <LogEntryList
          entries={entries}
          highlightCategory="debug"
          virtualListComponent={VirtualList}
          RowComponent={StubRow}
          matchIndices={[0]}
          activeMatchIndex={0}
          searchTerm="debug"
        />
      );

      await waitFor(() => {
        expect(captured.highlighted[0]).toBe(true);
        expect(captured.highlighted[1]).toBe(false);
        expect(captured.highlighted['0-match']).toBe(true);
        expect(captured.highlighted['0-active']).toBe(true);
      });

      await waitFor(() => {
        expect(captured.measured.length).toBeGreaterThan(0);
      });
    });
  });
});
