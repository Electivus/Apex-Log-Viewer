import type { ParsedLogEntry } from './logViewerParser';
import type { LogDiagnostic } from '../../shared/logTriage';

type LogDiagnosticSeverity = LogDiagnostic['severity'];

export interface LogViewerMappedDiagnostic extends LogDiagnostic {
  originalIndex: number;
  mappedEntryId?: number;
  mappedLineNumber?: number;
}

export interface LogEntryDiagnosticGroup {
  entry: ParsedLogEntry;
  diagnostics: LogViewerMappedDiagnostic[];
}

export interface MappedDiagnosticsResult {
  orderedDiagnostics: LogViewerMappedDiagnostic[];
  mappedEntries: LogEntryDiagnosticGroup[];
  unmappedDiagnostics: LogViewerMappedDiagnostic[];
}

export interface BuildVisibleEntriesArgs {
  entries: ReadonlyArray<LogEntryDiagnosticGroup>;
  shouldIncludeEntry: (entry: ParsedLogEntry) => boolean;
  activeDiagnostic?: LogViewerMappedDiagnostic;
}

const hasExactLine = (line: number | undefined): line is number => {
  return typeof line === 'number' && Number.isInteger(line) && Number.isFinite(line);
};

const SEVERITY_ORDER: Record<LogDiagnosticSeverity, number> = {
  error: 0,
  warning: 1
};

function bySeverityThenOriginalOrder(a: LogViewerMappedDiagnostic, b: LogViewerMappedDiagnostic): number {
  const aSeverity = SEVERITY_ORDER[a.severity] ?? 1;
  const bSeverity = SEVERITY_ORDER[b.severity] ?? 1;
  if (aSeverity !== bSeverity) {
    return aSeverity - bSeverity;
  }
  return a.originalIndex - b.originalIndex;
}

export function orderDiagnostics(reasons: readonly LogDiagnostic[]): LogViewerMappedDiagnostic[] {
  return reasons
    .map((reason, index) => ({
      ...reason,
      originalIndex: index
    }))
    .sort((a, b) => {
      const aHasLine = hasExactLine(a.line);
      const bHasLine = hasExactLine(b.line);
      if (aHasLine && !bHasLine) {
        return -1;
      }
      if (!aHasLine && bHasLine) {
        return 1;
      }
      if (aHasLine && bHasLine) {
        const aLine = a.line as number;
        const bLine = b.line as number;
        if (aLine !== bLine) {
          return aLine - bLine;
        }
      }
      return a.originalIndex - b.originalIndex;
    });
}

export function mapDiagnosticsToEntries(
  entries: readonly ParsedLogEntry[],
  reasons: readonly LogDiagnostic[]
): MappedDiagnosticsResult {
  const orderedDiagnostics = orderDiagnostics(reasons);
  const mappedEntries: LogEntryDiagnosticGroup[] = entries.map(entry => ({
    entry,
    diagnostics: []
  }));

  // Policy: when duplicate line numbers exist in ParsedLogEntry list (realistic for some sources),
  // always keep the first matching row for deterministic, stable mapping.
  const byLine = new Map<number, LogEntryDiagnosticGroup>();
  const byPhysicalLine = new Map<number, LogEntryDiagnosticGroup>();
  const unmappedDiagnostics: LogViewerMappedDiagnostic[] = [];

  for (const row of mappedEntries) {
    byPhysicalLine.set(row.entry.id + 1, row);
    if (hasExactLine(row.entry.lineNumber)) {
      if (!byLine.has(row.entry.lineNumber)) {
        byLine.set(row.entry.lineNumber, row);
      }
    }
  }

  for (const reason of orderedDiagnostics) {
    if (!hasExactLine(reason.line)) {
      unmappedDiagnostics.push(reason);
      continue;
    }

    const target = byLine.get(reason.line);
    if (target) {
      target.diagnostics.push({
        ...reason,
        mappedEntryId: target.entry.id,
        mappedLineNumber: reason.line
      });
      continue;
    }

    const fallbackTarget = byPhysicalLine.get(reason.line);
    if (fallbackTarget) {
      fallbackTarget.diagnostics.push({
        ...reason,
        mappedEntryId: fallbackTarget.entry.id,
        mappedLineNumber: reason.line
      });
      continue;
    }

    unmappedDiagnostics.push(reason);
  }

  const collapsedEntries = mappedEntries.map(group => ({
    ...group,
    diagnostics: [...group.diagnostics].sort(bySeverityThenOriginalOrder)
  }));

  return {
    orderedDiagnostics,
    mappedEntries: collapsedEntries,
    unmappedDiagnostics
  };
}

export function buildVisibleEntries({
  entries,
  shouldIncludeEntry,
  activeDiagnostic
}: BuildVisibleEntriesArgs): LogEntryDiagnosticGroup[] {
  const activeMappedEntryId = activeDiagnostic?.mappedEntryId;

  return entries.filter(({ entry }) => {
    if (shouldIncludeEntry(entry)) {
      return true;
    }
    if (activeMappedEntryId === undefined) {
      return false;
    }
    return entry.id === activeMappedEntryId;
  });
}
