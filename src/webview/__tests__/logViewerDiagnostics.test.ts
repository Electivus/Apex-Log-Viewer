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
      { code: 'dml_failure', severity: 'warning', summary: 'unmapped', line: 3 },
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
});
