import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { LogCategory, ParsedLogEntry } from '../utils/logViewerParser';
import type { LogViewerMappedDiagnostic } from '../utils/logViewerDiagnostics';
import { LogViewerFilters } from '../components/log-viewer/LogViewerFilters';
import { LogViewerHeader } from '../components/log-viewer/LogViewerHeader';
import { LogViewerStatusBar } from '../components/log-viewer/LogViewerStatusBar';
import { LogDiagnosticsSidebar } from '../components/log-viewer/LogDiagnosticsSidebar';
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
          counts={{ total: 1234, debug: 12, errors: 2, soql: 5, dml: 3 }}
          locale="en-US"
        />
      );

      fireEvent.click(screen.getByText('Debug Only'));
      expect(calls[0]).toBe('debug');

      fireEvent.click(screen.getByText('SOQL'));
      expect(calls[1]).toBe('soql');

      fireEvent.click(screen.getByText('Errors'));
      expect(calls[2]).toBe('error');

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
            counts={{ total: 999, debug: 456, errors: 78, soql: 0, dml: 0 }}
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
          counts={{ total: 2048, debug: 20, errors: 3, soql: 10, dml: 4 }}
          locale="en-US"
          metadata={{ sizeBytes: 1536, modifiedAt: '2025-09-21T17:30:00.000Z' }}
        />
      );

      screen.getByText('Total Lines: 2,048');
      screen.getByText('Debug Statements: 20');
      screen.getByText('Error Events: 3');
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
            counts={{ total: 12, debug: 1, errors: 0, soql: 2, dml: 3 }}
            locale="bad-locale"
            metadata={{ sizeBytes: 512, modifiedAt: 'not-a-date' }}
          />
        );
        screen.getByText('Error Events: 0');
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

    it.each(['debug', 'soql', 'dml', 'code', 'limit', 'system', 'error', 'other'] as LogCategory[])(
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

    it('renders passive diagnostic badges', () => {
      const diagnostics: LogViewerMappedDiagnostic[] = [
        {
          code: 'dml_failure',
          severity: 'warning',
          summary: 'Mapped warning',
          originalIndex: 1,
          mappedEntryId: 1,
          mappedLineNumber: 12
        }
      ];
      render(
        <LogEntryRow entry={baseEntry} highlighted={false} diagnostics={diagnostics} onMeasured={() => {}} />
      );
      const passiveBadge = screen.getByText('Mapped warning');
      expect(passiveBadge.className).toContain('bg-muted/20');
      expect(passiveBadge.className).toContain('text-[11px]');
    });

    it('renders stronger active diagnostic badge style and active row highlight', () => {
      const diagnostics: LogViewerMappedDiagnostic[] = [
        {
          code: 'fatal_exception',
          severity: 'error',
          summary: 'Mapped error',
          originalIndex: 3,
          mappedEntryId: 1,
          mappedLineNumber: 12
        }
      ];
      const { container } = render(
        <LogEntryRow
          entry={baseEntry}
          highlighted={false}
          diagnostics={diagnostics}
          activeDiagnosticId={3}
          isActiveDiagnostic
          onMeasured={() => {}}
        />
      );
      const rowElement = container.firstElementChild as HTMLDivElement | null;
      expect(rowElement?.className).toContain('ring-2');
      const activeBadge = screen.getByText('Mapped error');
      expect(activeBadge.className).toContain('bg-amber-500/30');
    });
  });

  describe('LogDiagnosticsSidebar', () => {
    const diagnostics: LogViewerMappedDiagnostic[] = [
      {
        code: 'fatal_exception',
        severity: 'error',
        summary: 'Fatal exception',
        originalIndex: 1,
        mappedLineNumber: 11
      },
      {
        code: 'validation_failure',
        severity: 'warning',
        summary: 'Validation warning',
        originalIndex: 2,
        mappedLineNumber: undefined
      }
    ];

    it('renders loading, empty, and ready states', () => {
      const { rerender } = render(
        <LogDiagnosticsSidebar
          diagnostics={diagnostics}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="loading"
        />
      );
      screen.getByText('Loading diagnostics…');

      rerender(
        <LogDiagnosticsSidebar
          diagnostics={[]}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="empty"
        />
      );
      screen.getByText('No diagnostics found.');

      rerender(
        <LogDiagnosticsSidebar
          diagnostics={diagnostics}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
        />
      );
      screen.getByText('Fatal exception');
      screen.getByText('Validation warning');
    });

    it('switches severity filters with All/Errors/Warnings controls', () => {
      const calls: string[] = [];
      render(
        <LogDiagnosticsSidebar
          diagnostics={diagnostics}
          filter="all"
          onFilterChange={next => calls.push(next)}
          onSelectDiagnostic={() => {}}
          triageState="ready"
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
      expect(calls[0]).toBe('error');

      fireEvent.click(screen.getByRole('button', { name: 'Warnings' }));
      expect(calls[1]).toBe('warning');

      fireEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(calls[2]).toBe('all');
    });

    it('keeps unmapped diagnostics clickable without requiring list scroll state', () => {
      const selectCalls: number[] = [];
      render(
        <LogDiagnosticsSidebar
          diagnostics={diagnostics}
          filter="all"
          activeId={2}
          onFilterChange={() => {}}
          onSelectDiagnostic={id => selectCalls.push(id)}
          triageState="ready"
        />
      );
      const warningItem = screen.getByText('Validation warning');
      fireEvent.click(warningItem);
      expect(selectCalls).toEqual([2]);
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

      const StubRow = ({ entry, highlighted, onMeasured, isMatch, isActiveMatch, diagnostics, activeDiagnosticId, isActiveDiagnostic }: any) => {
        React.useEffect(() => {
          const value = 72 + entry.id;
          captured.measured.push(value);
          onMeasured(value);
        }, [entry, onMeasured]);
        captured.highlighted[entry.id] = highlighted;
        captured.highlighted[`${entry.id}-match`] = isMatch;
        captured.highlighted[`${entry.id}-active`] = isActiveMatch;
        captured.highlighted[`${entry.id}-diag-count`] = diagnostics?.length ?? 0;
        captured.highlighted[`${entry.id}-active-diag`] = !!isActiveDiagnostic;
        captured.highlighted[`${entry.id}-active-diag-id`] = activeDiagnosticId;
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
          activeDiagnosticEntryIndex={0}
          activeDiagnosticId={1}
          entryDiagnosticSummaries={[{ entryId: 0, diagnostics: [{ code: 'fatal_exception', severity: 'error', summary: 'row-0', originalIndex: 1 }] }]}
        />
      );

      await waitFor(() => {
        expect(captured.highlighted[0]).toBe(true);
        expect(captured.highlighted[1]).toBe(false);
        expect(captured.highlighted['0-match']).toBe(true);
        expect(captured.highlighted['0-active']).toBe(true);
        expect(captured.highlighted['0-diag-count']).toBe(1);
        expect(captured.highlighted['0-active-diag']).toBe(true);
        expect(captured.highlighted['0-active-diag-id']).toBe(1);
      });

      await waitFor(() => {
        expect(captured.measured.length).toBeGreaterThan(0);
      });
    });

    it('scrolls only with active diagnostic entry index, not unmapped id alone', async () => {
      const scrollCalls: number[] = [];
      const entries: ParsedLogEntry[] = [
        { id: 0, timestamp: '00:00', type: 'USER_DEBUG', message: 'A', raw: 'raw', category: 'debug' },
        { id: 1, timestamp: '00:01', type: 'SOQL', message: 'B', raw: 'raw', category: 'soql' }
      ];

      const VirtualList = ({ rowCount, rowHeight, rowComponent, rowProps, listRef }: any) => {
        return (
          <div
            ref={el => {
              const api = { element: el, scrollToRow: (opts: { index: number }) => scrollCalls.push(opts.index) };
              if (typeof listRef === 'function') {
                listRef(api);
              } else if (listRef && 'current' in listRef) {
                (listRef as { current: unknown }).current = api;
              }
            }}
          >
            {Array.from({ length: rowCount }).map((_, index) => (
              <React.Fragment key={index}>{rowComponent({ ...rowProps, index, style: { height: rowHeight(index) } })}</React.Fragment>
            ))}
          </div>
        );
      };

      const { rerender } = render(
        <LogEntryList
          entries={entries}
          virtualListComponent={VirtualList}
          activeDiagnosticEntryIndex={1}
          RowComponent={() => <div />}
        />
      );

      await waitFor(() => {
        expect(scrollCalls).toEqual([1]);
      });

      rerender(
        <LogEntryList
          entries={entries}
          virtualListComponent={VirtualList}
          activeDiagnosticId={9}
          activeDiagnosticEntryIndex={undefined}
          RowComponent={() => <div />}
        />
      );
      expect(scrollCalls).toEqual([1]);
    });
  });
});
