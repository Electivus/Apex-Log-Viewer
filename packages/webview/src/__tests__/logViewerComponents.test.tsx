import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { LogCategory, ParsedLogEntry } from '../utils/logViewerParser';
import type { LogViewerMappedDiagnostic } from '../utils/logViewerDiagnostics';
import { LogViewerFilters } from '../components/log-viewer/LogViewerFilters';
import { LogViewerHeader } from '../components/log-viewer/LogViewerHeader';
import { LogFailureBanner } from '../components/log-viewer/LogFailureBanner';
import { LogViewerStatusBar } from '../components/log-viewer/LogViewerStatusBar';
import { LogDiagnosticsSidebar } from '../components/log-viewer/LogDiagnosticsSidebar';
import { LogEntryRow } from '../components/log-viewer/LogEntryRow';
import { LogEntryList } from '../components/log-viewer/LogEntryList';
import { logViewerPtBR } from '../i18n/logViewer';

/** A test double for react-window's `List`, whose own return type the doubles do not match. */
const asVirtualList = (component: (props: any) => React.ReactElement) =>
  component as unknown as NonNullable<React.ComponentProps<typeof LogEntryList>['virtualListComponent']>;

describe('Log viewer components', () => {
  describe('LogViewerHeader', () => {
    it('handles search updates, disables controls, and exposes navigation', () => {
      const changes: string[] = [];
      const viewCalls: number[] = [];
      const { unmount } = render(
        <LogViewerHeader
          heading={{ title: 'MyLog.log', details: [] }}
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
          heading={{ details: [] }}
          search="debug"
          onSearchChange={value => enabledChanges.push(value)}
          onViewRaw={() => enabledView.push(1)}
          matchCount={2}
          activeMatchIndex={1}
          onNextMatch={() => nextCalls.push(1)}
          onPreviousMatch={() => prevCalls.push(1)}
        />
      );
      screen.getByRole('heading', { name: 'Apex Log Viewer' });

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

  describe('LogViewerHeader heading', () => {
    it('titles the log with its entry point and mutes the rest, skipping what is missing', () => {
      render(
        <LogViewerHeader
          heading={{ title: 'execute_anonymous_apex', details: ['ana@example.com', '184 ms', '07L1.log'] }}
          search=""
          onSearchChange={() => {}}
          onViewRaw={() => {}}
        />
      );
      const title = screen.getByRole('heading', { name: 'execute_anonymous_apex' });
      expect(title).toHaveAttribute('title', 'execute_anonymous_apex');
      expect(screen.getByText('ana@example.com · 184 ms · 07L1.log')).toBeInTheDocument();
    });

    it('gives the icon-only match buttons a title', () => {
      render(
        <LogViewerHeader
          heading={{ details: [] }}
          search="x"
          onSearchChange={() => {}}
          onViewRaw={() => {}}
          matchCount={1}
          t={logViewerPtBR}
        />
      );
      expect(screen.getByRole('button', { name: 'Ocorrência anterior' })).toHaveAttribute('title', 'Ocorrência anterior');
      expect(screen.getByRole('button', { name: 'Próxima ocorrência' })).toHaveAttribute('title', 'Próxima ocorrência');
    });
  });

  describe('LogFailureBanner', () => {
    const failure = { message: 'System.MathException: Divide by 0', lineNumber: 5, entryId: 3, type: 'FATAL_ERROR' };

    it('shows the real message and line, and goes to the error on click', () => {
      const calls: number[] = [];
      render(<LogFailureBanner failure={failure} onGoToError={() => calls.push(1)} />);
      const banner = screen.getByRole('alert', { name: 'Failure' });
      expect(banner).toHaveTextContent('System.MathException: Divide by 0');
      expect(banner).toHaveTextContent('Line 5');
      fireEvent.click(screen.getByRole('button', { name: 'Go to error' }));
      expect(calls).toHaveLength(1);
    });

    it('leaves out the line when the log has none, and speaks Portuguese', () => {
      render(
        <LogFailureBanner failure={{ ...failure, lineNumber: undefined }} onGoToError={() => {}} t={logViewerPtBR} />
      );
      expect(screen.getByRole('alert', { name: 'Falha' })).not.toHaveTextContent('Linha');
      screen.getByRole('button', { name: 'Ir para o erro' });
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

      fireEvent.click(screen.getByRole('button', { name: 'Debug Only 12' }));
      expect(calls[0]).toBe('debug');

      fireEvent.click(screen.getByRole('button', { name: 'SOQL 5' }));
      expect(calls[1]).toBe('soql');

      fireEvent.click(screen.getByRole('button', { name: 'Errors 2' }));
      expect(calls[2]).toBe('error');

      fireEvent.click(screen.getByRole('button', { name: 'DML 3' }));
      expect(calls[3]).toBe('dml');

      const showing = screen.getByText(/entries$/);
      expect(showing.textContent?.includes('1,234 entries')).toBe(true);
    });

    it('gives every chip one resting style, marks only the active one, and clears it on a second click', () => {
      const calls: string[] = [];
      render(
        <LogViewerFilters
          active="soql"
          onChange={next => calls.push(next)}
          counts={{ total: 20, debug: 12, errors: 2, soql: 5, dml: 0 }}
          locale="en-US"
        />
      );
      const chips = screen.getAllByRole('button');
      expect(chips.map(chip => chip.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
      const resting = chips.filter(chip => chip.getAttribute('aria-pressed') === 'false');
      expect(new Set(resting.map(chip => chip.className.replace(/\s*disabled:\S+/g, ''))).size).toBe(1);
      expect(chips[2]!.className).toContain('bg-primary');
      expect(chips[2]!.className).not.toMatch(/bg-(sky|rose|emerald|orange)/);

      fireEvent.click(chips[2]!);
      expect(calls).toEqual(['all']);
    });

    it('disables a chip with nothing to show unless it is the active filter', () => {
      const counts = { total: 3, debug: 3, errors: 0, soql: 0, dml: 0 };
      const { rerender } = render(<LogViewerFilters active="all" onChange={() => {}} counts={counts} locale="en-US" />);
      expect(screen.getByRole('button', { name: 'Errors 0' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Debug Only 3' })).toBeEnabled();
      rerender(<LogViewerFilters active="error" onChange={() => {}} counts={counts} locale="en-US" />);
      expect(screen.getByRole('button', { name: 'Errors 0' })).toBeEnabled();
    });

    it('says entry for one row and entries otherwise, in English and Portuguese', () => {
      const counts = { total: 2, debug: 1, errors: 0, soql: 0, dml: 0 };
      const { rerender } = render(
        <LogViewerFilters active="debug" onChange={() => {}} counts={counts} locale="en-US" />
      );
      screen.getByText('1 entry');
      rerender(<LogViewerFilters active="all" onChange={() => {}} counts={counts} locale="en-US" />);
      screen.getByText('2 entries');
      rerender(<LogViewerFilters active="error" onChange={() => {}} counts={counts} locale="en-US" />);
      screen.getByText('0 entries');
      rerender(
        <LogViewerFilters active="debug" onChange={() => {}} counts={counts} locale="pt-BR" t={logViewerPtBR} />
      );
      screen.getByText('1 entrada');
      screen.getByText('Exibindo:');
      screen.getByText('Somente debug');
      rerender(<LogViewerFilters active="all" onChange={() => {}} counts={counts} locale="pt-BR" t={logViewerPtBR} />);
      screen.getByText('2 entradas');
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
          totalLines={2048}
          locale="en-US"
          metadata={{ sizeBytes: 1536, modifiedAt: '2025-09-21T17:30:00.000Z' }}
        />
      );

      screen.getByText('Total Lines: 2,048');
      expect(screen.queryByText(/Debug Statements|Error Events|SOQL Queries|DML Operations/)).toBeNull();
      screen.getByText('Size: 1.5 KB');
      expect(screen.getByText(/Updated:/)).toHaveTextContent('Updated:');
      screen.getByText('Ready');
    });

    it('says Loading while the log is on its way and Not loaded after a failure, not Ready', () => {
      const { rerender } = render(<LogViewerStatusBar totalLines={0} locale="en-US" state="loading" />);
      screen.getByText('Loading…');
      expect(screen.queryByText('Ready')).toBeNull();
      rerender(<LogViewerStatusBar totalLines={0} locale="en-US" state="failed" />);
      screen.getByText('Not loaded');
      expect(screen.queryByText('Ready')).toBeNull();
      rerender(
        <LogViewerStatusBar totalLines={1234} locale="pt-BR" state="ready" t={logViewerPtBR} />
      );
      screen.getByText('Pronto');
      screen.getByText('Total de linhas: 1.234');
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
            totalLines={12}
            locale="bad-locale"
            metadata={{ sizeBytes: 512, modifiedAt: 'not-a-date' }}
          />
        );
        screen.getByText('Total Lines: 12');
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
      expect(row?.className).toContain('log-row-highlighted');
      expect(measured.length).toBeGreaterThan(0);
      expect(screen.getByText('Context info')).toBeInTheDocument();
    });

    it.each(['debug', 'soql', 'dml', 'code', 'limit', 'system', 'error', 'other'] as LogCategory[])(
      'applies visuals for %s entries',
      category => {
        const entry = { ...baseEntry, category, type: category.toUpperCase(), details: undefined };
        render(<LogEntryRow entry={entry} highlighted={false} onMeasured={() => {}} />);
        const badge = screen.getByTitle(entry.type);
        expect(badge.className).toContain('log-cat-badge');
        expect(badge.className).toMatch(/log-cat-(debug|soql|dml|code|limit|error|neutral)/);
        expect(badge.className).not.toMatch(/(?:text|bg|border)-(?:red|sky|emerald|orange|purple|yellow|slate|amber)-/);
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
      expect(mark?.className).toContain('log-find-mark');
      expect(document.querySelector('.log-row-active-match')).not.toBeNull();
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
      expect(passiveBadge.className).toContain('log-sev-warning');
      expect(passiveBadge.className).not.toContain('border-ring');
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
      expect(rowElement?.className).toContain('log-selected');
      const activeBadge = screen.getByText('Mapped error');
      expect(activeBadge.className).toContain('border-ring');
    });
  });

  describe('LogEntryRow columns', () => {
    const entry: ParsedLogEntry = {
      id: 1,
      timestamp: '12:00:00.0',
      type: 'CUMULATIVE_LIMIT_USAGE_END_OF_TRANSACTION',
      message: 'Number of SOQL queries: 1 out of 100',
      raw: '12:00:00.0 (1)|CUMULATIVE_LIMIT_USAGE_END_OF_TRANSACTION|Number of SOQL queries: 1 out of 100',
      category: 'limit',
      lineNumber: 7
    };

    it('lays every row on the same fixed tracks, whatever its type says', () => {
      const { container } = render(
        <>
          <LogEntryRow entry={entry} highlighted={false} onMeasured={() => {}} />
          <LogEntryRow entry={{ ...entry, id: 2, type: 'USER_DEBUG', category: 'debug' }} highlighted={false} onMeasured={() => {}} />
        </>
      );
      const [long, short] = Array.from(container.children) as HTMLElement[];
      expect(long!.className).toBe(short!.className);
      expect(long!.className).toContain('grid-cols-[5.5rem_10.5rem_3rem_minmax(0,1fr)]');
      expect(long!.children).toHaveLength(4);
    });

    it('truncates a long type and keeps it readable in the title', () => {
      render(<LogEntryRow entry={entry} highlighted={false} onMeasured={() => {}} />);
      const badge = screen.getByTitle('CUMULATIVE_LIMIT_USAGE_END_OF_TRANSACTION');
      expect(badge.querySelector('.truncate')).toHaveTextContent('CUMULATIVE_LIMIT_USAGE_END_OF_TRANSACTION');
      expect(badge.className).toContain('max-w-full');
    });

    it('shows the entry message and leaves it empty for an event that has none, instead of repeating the raw line', () => {
      const started: ParsedLogEntry = {
        id: 0,
        timestamp: '12:00:00.0',
        type: 'EXECUTION_STARTED',
        message: '',
        raw: '12:00:00.0 (1)|EXECUTION_STARTED',
        category: 'other'
      };
      const { container } = render(<LogEntryRow entry={started} highlighted={false} onMeasured={() => {}} />);
      expect(container).not.toHaveTextContent('12:00:00.0 (1)|EXECUTION_STARTED');
      const message = container.firstElementChild!.children[3]!;
      expect(message).toHaveTextContent('');
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

    it('renders loading, unavailable, empty, and ready states', () => {
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
          triageState="unavailable"
        />
      );
      screen.getByText('Diagnostics unavailable.');

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
          diagnostics={[]}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
          primaryReason="Fatal exception"
        />
      );
      screen.getByText('Fatal exception');

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

    it('shows the real message of the mapped entry, with the code and line, and the summary when there is none', () => {
      render(
        <LogDiagnosticsSidebar
          diagnostics={[
            {
              code: 'fatal_exception',
              severity: 'error',
              summary: 'Fatal exception',
              originalIndex: 1,
              mappedLineNumber: 5,
              mappedMessage: 'System.MathException: Divide by 0'
            },
            { code: 'dml_failure', severity: 'warning', summary: 'DML failure', originalIndex: 2, mappedLineNumber: 9 }
          ]}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
        />
      );
      const first = screen.getByRole('button', { name: /Divide by 0/ });
      expect(first).toHaveTextContent('fatal exception');
      expect(first).toHaveTextContent('Line 5');
      expect(first).not.toHaveTextContent('Fatal exception');
      expect(within(first).getByRole('img', { name: 'error' })).toBeInTheDocument();
      const second = screen.getByRole('button', { name: /DML failure/ });
      expect(within(second).getByRole('img', { name: 'warning' })).toBeInTheDocument();
      expect(second.querySelector('.lucide-funnel, .lucide-filter')).toBeNull();
    });

    it('marks the active severity tab with the default button style', () => {
      render(
        <LogDiagnosticsSidebar
          diagnostics={diagnostics}
          filter="warning"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
        />
      );
      const warnings = screen.getByRole('button', { name: 'Warnings' });
      expect(warnings).toHaveAttribute('aria-pressed', 'true');
      expect(warnings.className).toContain('bg-primary');
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'All' }).className).not.toContain('bg-primary');
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

    it('preserves the parser line number when a diagnostic cannot map to a rendered row', () => {
      render(
        <LogDiagnosticsSidebar
          diagnostics={[
            {
              code: 'suspicious_error_payload',
              severity: 'warning',
              summary: 'Original parser line',
              originalIndex: 3,
              line: 99
            }
          ]}
          filter="all"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
        />
      );

      screen.getByText('Line 99');
      expect(screen.queryByText('Unmapped')).toBeNull();
    });

    it('shows an empty filtered state when the current severity has no matches', () => {
      render(
        <LogDiagnosticsSidebar
          diagnostics={[
            {
              code: 'validation_failure',
              severity: 'warning',
              summary: 'Validation warning',
              originalIndex: 2,
              mappedLineNumber: undefined
            }
          ]}
          filter="error"
          onFilterChange={() => {}}
          onSelectDiagnostic={() => {}}
          triageState="ready"
          primaryReason="Validation warning"
        />
      );

      screen.getByText('No diagnostics found.');
      expect(screen.queryByText('Validation warning')).toBeNull();
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

      const captured: { measured: number[]; highlighted: Record<string, unknown> } = {
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
          virtualListComponent={asVirtualList(VirtualList)}
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
          virtualListComponent={asVirtualList(VirtualList)}
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
          virtualListComponent={asVirtualList(VirtualList)}
          activeDiagnosticId={9}
          activeDiagnosticEntryIndex={undefined}
          RowComponent={() => <div />}
        />
      );
      expect(scrollCalls).toEqual([1]);
    });

    it('re-scrolls when a different diagnostic becomes active on the same row', async () => {
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
          virtualListComponent={asVirtualList(VirtualList)}
          activeDiagnosticId={1}
          activeDiagnosticEntryIndex={1}
          RowComponent={() => <div />}
        />
      );

      await waitFor(() => {
        expect(scrollCalls).toEqual([1]);
      });

      scrollCalls.length = 0;
      rerender(
        <LogEntryList
          entries={entries}
          virtualListComponent={asVirtualList(VirtualList)}
          activeDiagnosticId={2}
          activeDiagnosticEntryIndex={1}
          RowComponent={() => <div />}
        />
      );

      await waitFor(() => {
        expect(scrollCalls).toEqual([1]);
      });
    });

    it('sizes the virtual list to its container instead of the window height', () => {
      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      const entries: ParsedLogEntry[] = [
        { id: 0, timestamp: '00:00', type: 'USER_DEBUG', message: 'A', raw: 'raw', category: 'debug' },
        { id: 1, timestamp: '00:01', type: 'SOQL', message: 'B', raw: 'raw', category: 'soql' }
      ];
      const captured: { style?: React.CSSProperties } = {};

      const VirtualList = ({ rowCount, rowHeight, rowComponent, rowProps, style }: any) => {
        captured.style = style;
        return (
          <div style={style}>
            {Array.from({ length: rowCount }).map((_, index) => (
              <React.Fragment key={index}>{rowComponent({ ...rowProps, index, style: { height: rowHeight(index) } })}</React.Fragment>
            ))}
          </div>
        );
      };

      try {
        render(<LogEntryList entries={entries} virtualListComponent={asVirtualList(VirtualList)} RowComponent={() => <div />} />);
        expect(captured.style?.height).toBeUndefined();
      } finally {
        Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
      }
    });
  });
});
