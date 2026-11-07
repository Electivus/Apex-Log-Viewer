import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { List, useDynamicRowHeight, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import type { ParsedLogEntry, LogCategory } from '../../utils/logViewerParser';
import type { LogViewerMappedDiagnostic } from '../../utils/logViewerDiagnostics';
import { LogEntryRow } from './LogEntryRow';
import { logViewerEn } from '../../i18n/logViewer';

export type LogEntryDiagnosticSummary = {
  entryId: number;
  diagnostics: readonly LogViewerMappedDiagnostic[];
};

interface Props {
  entries: ParsedLogEntry[];
  highlightCategory?: LogCategory;
  matchIndices?: number[];
  activeMatchIndex?: number;
  entryDiagnosticSummaries?: readonly LogEntryDiagnosticSummary[];
  activeDiagnosticId?: number;
  activeDiagnosticEntryIndex?: number;
  /** A new value scrolls to the active entry again, for a jump that points at the same row twice. */
  scrollRequest?: number;
  searchTerm?: string;
  listRef?: React.RefObject<ListImperativeAPI | null>;
  virtualListComponent?: typeof List;
  RowComponent?: typeof LogEntryRow;
  noEntriesText?: string;
}

const ONE_LINE_ROW_HEIGHT = 31;

type EntryRowProps = {
  entries: ParsedLogEntry[];
  highlightCategory?: LogCategory;
  matchSet: ReadonlySet<number> | null;
  activeMatchEntryIndex?: number;
  activeDiagnosticId?: number;
  activeDiagnosticEntryIndex?: number;
  diagnosticsByEntryId: ReadonlyMap<number, readonly LogViewerMappedDiagnostic[]>;
  searchTerm?: string;
  Row: typeof LogEntryRow;
};

function EntryRow({
  index,
  style,
  entries,
  highlightCategory,
  matchSet,
  activeMatchEntryIndex,
  activeDiagnosticId,
  activeDiagnosticEntryIndex,
  diagnosticsByEntryId,
  searchTerm,
  Row
}: RowComponentProps<EntryRowProps>) {
  const entry = entries[index];
  if (!entry) return null;
  const isMatch = matchSet ? matchSet.has(index) : false;
  return (
    <div style={style}>
      <Row
        entry={entry}
        highlighted={highlightCategory ? entry.category === highlightCategory : false}
        isMatch={isMatch}
        isActiveMatch={isMatch && activeMatchEntryIndex === index}
        isActiveDiagnostic={index === activeDiagnosticEntryIndex}
        diagnostics={diagnosticsByEntryId.get(entry.id) ?? []}
        activeDiagnosticId={activeDiagnosticId}
        searchTerm={searchTerm}
      />
    </div>
  );
}

export function LogEntryList({
  entries,
  highlightCategory,
  matchIndices,
  activeMatchIndex,
  entryDiagnosticSummaries,
  activeDiagnosticId,
  activeDiagnosticEntryIndex,
  scrollRequest,
  searchTerm,
  listRef,
  virtualListComponent,
  RowComponent,
  noEntriesText = logViewerEn.noEntriesMatch
}: Props) {
  // A jump in a list with this cache keeps scrolling until the rows it lands on have been measured, which a plain
  // height function would not do: those rows grow after the jump and push the target out of view.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: ONE_LINE_ROW_HEIGHT });
  const internalListRef = useRef<ListImperativeAPI | null>(null);
  const resolvedListRef = listRef ?? internalListRef;
  const VirtualList = virtualListComponent ?? List;
  const Row = RowComponent ?? LogEntryRow;

  const matchSet = useMemo(() => {
    if (!matchIndices || matchIndices.length === 0) {
      return null;
    }
    return new Set(matchIndices);
  }, [matchIndices]);

  const diagnosticsByEntryId = useMemo(() => {
    const map = new Map<number, readonly LogViewerMappedDiagnostic[]>();
    for (const summary of entryDiagnosticSummaries ?? []) {
      if (summary?.entryId === undefined || summary.entryId === null) {
        continue;
      }
      map.set(summary.entryId, summary.diagnostics ?? []);
    }
    return map;
  }, [entryDiagnosticSummaries]);

  const activeMatchEntryIndex = useMemo(() => {
    if (activeMatchIndex === undefined || activeMatchIndex === null || activeMatchIndex < 0) {
      return undefined;
    }
    return matchIndices?.[activeMatchIndex];
  }, [activeMatchIndex, matchIndices]);

  useLayoutEffect(() => {
    if (
      activeDiagnosticEntryIndex === undefined ||
      activeDiagnosticEntryIndex === null ||
      activeDiagnosticEntryIndex < 0 ||
      activeDiagnosticEntryIndex >= entries.length
    ) {
      return;
    }
    resolvedListRef.current?.scrollToRow({
      index: activeDiagnosticEntryIndex,
      align: 'center'
    });
  }, [activeDiagnosticEntryIndex, activeDiagnosticId, scrollRequest, entries.length, resolvedListRef]);

  const rowProps = useMemo<EntryRowProps>(
    () => ({
      entries,
      highlightCategory,
      matchSet,
      activeMatchEntryIndex,
      activeDiagnosticId,
      activeDiagnosticEntryIndex,
      diagnosticsByEntryId,
      searchTerm,
      Row
    }),
    [
      entries,
      highlightCategory,
      matchSet,
      activeMatchEntryIndex,
      activeDiagnosticId,
      activeDiagnosticEntryIndex,
      diagnosticsByEntryId,
      searchTerm,
      Row
    ]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {entries.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">{noEntriesText}</div>
      ) : (
        <VirtualList
          listRef={resolvedListRef}
          style={{ width: '100%' }}
          rowCount={entries.length}
          rowHeight={rowHeight}
          overscanCount={12}
          rowProps={rowProps}
          rowComponent={EntryRow}
        />
      )}
    </div>
  );
}
