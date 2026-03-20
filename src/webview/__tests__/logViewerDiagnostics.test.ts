import type { ParsedLogEntry } from '../utils/logViewerParser';
import { buildVisibleEntries, mapDiagnosticsToEntries, orderDiagnostics } from '../utils/logViewerDiagnostics';

const makeEntry = (id: number, lineNumber: number | undefined, category: ParsedLogEntry['category']): ParsedLogEntry => ({
  id,
  timestamp: '00:00:00.000',
  type: 'INFO',
  message: `line-${id}`,
  raw: `raw-${id}`,
  category,
  lineNumber
});

describe('logViewerDiagnostics', () => {
  it('orders diagnostics by ascending line number and keeps no-line diagnostics after mapped diagnostics', () => {
    const ordered = orderDiagnostics([
      { code: 'validation_failure', severity: 'warning', summary: 'third', line: 12 },
      { code: 'fatal_exception', severity: 'error', summary: 'unmapped-2' },
      { code: 'dml_failure', severity: 'warning', summary: 'first', line: 2 },
      { code: 'assertion_failure', severity: 'error', summary: 'unmapped-1' },
      { code: 'suspicious_error_payload', severity: 'warning', summary: 'second', line: 8 }
    ]);

    expect(ordered.map(d => d.summary)).toEqual([
      'first',
      'second',
      'third',
      'unmapped-2',
      'unmapped-1'
    ]);
  });

  it('maps diagnostic.line to ParsedLogEntry.lineNumber exactly (1-based) and keeps unmapped diagnostics', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, 1, 'other'),
      makeEntry(1, 9, 'other'),
      makeEntry(2, 10, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'dml_failure', severity: 'warning', summary: 'mapped-10', line: 10 },
      { code: 'dml_failure', severity: 'warning', summary: 'mapped-1', line: 1 },
      { code: 'dml_failure', severity: 'warning', summary: 'unmapped', line: 30 },
      { code: 'dml_failure', severity: 'warning', summary: 'no-line' }
    ]);

    expect(result.orderedDiagnostics).toHaveLength(4);
    expect(result.mappedEntries[0].diagnostics).toEqual([
      expect.objectContaining({
        summary: 'mapped-1',
        mappedEntryId: 0,
        mappedLineNumber: 1
      })
    ]);
    expect(result.mappedEntries[2].diagnostics).toEqual([
      expect.objectContaining({
        summary: 'mapped-10',
        mappedEntryId: 2,
        mappedLineNumber: 10
      })
    ]);
    expect(result.unmappedDiagnostics.map(d => d.summary)).toEqual(['unmapped', 'no-line']);
  });

  it('falls back to rendered row mapping using entry.id + 1 when no ParsedLogEntry.lineNumber matches', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, undefined, 'other'),
      makeEntry(1, undefined, 'other'),
      makeEntry(2, undefined, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'dml_failure', severity: 'warning', summary: 'mapped-2', line: 2 },
      { code: 'dml_failure', severity: 'warning', summary: 'mapped-3', line: 3 },
      { code: 'dml_failure', severity: 'warning', summary: 'unmapped', line: 99 }
    ]);

    expect(result.mappedEntries[1].diagnostics).toEqual([
      expect.objectContaining({
        summary: 'mapped-2',
        mappedEntryId: 1,
        mappedLineNumber: 2
      })
    ]);
    expect(result.mappedEntries[2].diagnostics).toEqual([
      expect.objectContaining({
        summary: 'mapped-3',
        mappedEntryId: 2,
        mappedLineNumber: 3
      })
    ]);
    expect(result.unmappedDiagnostics.map(d => d.summary)).toEqual(['unmapped']);
  });

  it('falls back to rendered row mapping when lineNumber mismatches and all rows have bracketed line numbers', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, 12, 'other'),
      makeEntry(1, 13, 'other'),
      makeEntry(2, 14, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'dml_failure', severity: 'warning', summary: 'exact-line', line: 13 },
      { code: 'dml_failure', severity: 'warning', summary: 'fallback-line', line: 2 },
      { code: 'dml_failure', severity: 'warning', summary: 'still-unmapped', line: 99 }
    ]);

    expect(result.mappedEntries[1].diagnostics).toEqual([
      expect.objectContaining({
        summary: 'exact-line',
        mappedEntryId: 1,
        mappedLineNumber: 13
      }),
      expect.objectContaining({
        summary: 'fallback-line',
        mappedEntryId: 1,
        mappedLineNumber: 13
      })
    ]);
    expect(result.unmappedDiagnostics.map(d => d.summary)).toEqual(['still-unmapped']);
  });

  it('collapses diagnostics for a row by severity then original order for ties', () => {
    const entries: ParsedLogEntry[] = [makeEntry(0, 4, 'error'), makeEntry(1, 5, 'other')];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'validation_failure', severity: 'warning', summary: 'warning-first', line: 4 },
      { code: 'fatal_exception', severity: 'error', summary: 'error-one', line: 4 },
      { code: 'rollback_detected', severity: 'warning', summary: 'warning-second', line: 4 },
      { code: 'suspicious_error_payload', severity: 'warning', summary: 'warning-third', line: 4 }
    ]);

    expect(result.mappedEntries[0].diagnostics.map(d => d.summary)).toEqual([
      'error-one',
      'warning-first',
      'warning-second',
      'warning-third'
    ]);
  });

  it('keeps active mapped row visible when row filter would hide it', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, 1, 'other'),
      makeEntry(1, 2, 'error'),
      makeEntry(2, 3, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'fatal_exception', severity: 'error', summary: 'goes-to-row-1', line: 1 },
      { code: 'dml_failure', severity: 'warning', summary: 'goes-to-row-2', line: 2 }
    ]);
    const activeDiagnostic = result.mappedEntries[0]!.diagnostics.find(d => d.summary === 'goes-to-row-1');

    const visible = buildVisibleEntries({
      entries: result.mappedEntries,
      activeDiagnostic,
      shouldIncludeEntry: entry => entry.category === 'error'
    });

    expect(visible.map(v => v.entry.id)).toEqual([0, 1]);
  });

  it('maps multiple diagnostics with duplicate lineNumber to the first matching row only', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, 11, 'error'),
      makeEntry(1, 11, 'other'),
      makeEntry(2, 12, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'fatal_exception', severity: 'error', summary: 'for-11-primary', line: 11 },
      { code: 'dml_failure', severity: 'warning', summary: 'for-11-secondary', line: 11 },
      { code: 'rollback_detected', severity: 'warning', summary: 'for-12', line: 12 }
    ]);

    expect(result.mappedEntries[0].diagnostics.map(d => d.summary)).toEqual([
      'for-11-primary',
      'for-11-secondary'
    ]);
    expect(result.mappedEntries[1].diagnostics).toEqual([]);
    expect(result.mappedEntries[2].diagnostics).toEqual([
      expect.objectContaining({ summary: 'for-12', mappedEntryId: 2 })
    ]);
  });

  it('does not force visibility when active diagnostic is unmapped or lacks mappedEntryId', () => {
    const entries: ParsedLogEntry[] = [
      makeEntry(0, 1, 'other'),
      makeEntry(1, 2, 'other')
    ];
    const result = mapDiagnosticsToEntries(entries, [
      { code: 'fatal_exception', severity: 'error', summary: 'unmapped-line', line: 99 },
      { code: 'dml_failure', severity: 'warning', summary: 'unmapped-no-line' }
    ]);
    const activeDiagnostic = result.unmappedDiagnostics[0]!;

    const visible = buildVisibleEntries({
      entries: result.mappedEntries,
      activeDiagnostic,
      shouldIncludeEntry: () => false
    });

    expect(visible).toEqual([]);
  });
});
