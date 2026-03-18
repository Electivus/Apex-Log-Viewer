import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ParsedLogEntry, LogCategory } from '../../utils/logViewerParser';
import type { LogViewerMappedDiagnostic } from '../../utils/logViewerDiagnostics';
import { LogEntryRow } from './LogEntryRow';

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
  searchTerm?: string;
  listRef?: React.RefObject<ListImperativeAPI | null>;
  virtualListComponent?: typeof List;
  RowComponent?: typeof LogEntryRow;
}

export function LogEntryList({
  entries,
  highlightCategory,
  matchIndices,
  activeMatchIndex,
  entryDiagnosticSummaries,
  activeDiagnosticId,
  activeDiagnosticEntryIndex,
  searchTerm,
  listRef,
  virtualListComponent,
  RowComponent
}: Props) {
  const defaultRowHeight = 64;
  const rowHeightsRef = useRef<Record<number, number>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const internalListRef = useRef<ListImperativeAPI | null>(null);
  const resolvedListRef = listRef ?? internalListRef;
  const [height, setHeight] = useState<number>(420);
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);
  const VirtualList = virtualListComponent ?? List;
  const Row = RowComponent ?? LogEntryRow;

  const scheduleRerender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender(v => v + 1);
    });
  }, []);

  const setRowHeight = useCallback(
    (index: number, size: number) => {
      const next = Math.max(defaultRowHeight, Math.ceil(size));
      if (rowHeightsRef.current[index] !== next) {
        rowHeightsRef.current[index] = next;
        scheduleRerender();
      }
    },
    [defaultRowHeight, scheduleRerender]
  );

  const getItemSize = useCallback((index: number) => rowHeightsRef.current[index] ?? defaultRowHeight, [defaultRowHeight]);

  useLayoutEffect(() => {
    const recompute = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const top = rect?.top ?? 0;
      const available = Math.max(180, Math.floor(window.innerHeight - top - 16));
      setHeight(available);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogEntryList: failed to disconnect ResizeObserver', e);
      }
    };
  }, []);

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
      align: 'center',
      behavior: 'auto'
    });
  }, [activeDiagnosticEntryIndex, entries.length, resolvedListRef]);

  const data = useMemo(
    () => ({
      entries,
      highlightCategory,
      setRowHeight,
      matchSet,
      activeMatchEntryIndex,
      activeDiagnosticId,
      diagnosticsByEntryId,
      searchTerm
    }),
    [diagnosticsByEntryId, entries, highlightCategory, setRowHeight, matchSet, activeMatchEntryIndex, activeDiagnosticId, searchTerm]
  );

  const renderRow = useCallback(
    ({
      index,
      style,
      entries: listEntries,
      highlightCategory: target,
      setRowHeight: measure,
      matchSet: matchLookup,
      activeMatchEntryIndex: activeIndex,
      activeDiagnosticId: diagnosticId,
      diagnosticsByEntryId: diagnosticsById,
      searchTerm: term
    }: any) => {
      const entry = listEntries[index] as ParsedLogEntry | undefined;
      if (!entry) return null;
      const highlighted = target ? entry.category === target : false;
      const isMatch = matchLookup ? matchLookup.has(index) : false;
      const isActiveMatch = isMatch && activeIndex === index;
      const isActiveDiagnostic = index === activeDiagnosticEntryIndex;
      const rowDiagnostics = diagnosticsById.get(entry.id) ?? [];
      return (
        <div style={style}>
          <Row
            entry={entry}
            highlighted={highlighted}
            isMatch={isMatch}
            isActiveMatch={isActiveMatch}
            isActiveDiagnostic={isActiveDiagnostic}
            diagnostics={rowDiagnostics}
            activeDiagnosticId={diagnosticId}
            searchTerm={term}
            onMeasured={h => measure(index, h)}
          />
        </div>
      );
    },
    [activeDiagnosticEntryIndex]
  );

  return (
    <div ref={containerRef} className="flex-1">
      <div className="h-full overflow-hidden rounded-lg border border-border/60 bg-background/60 shadow-inner">
        {entries.length === 0 ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">No entries match the current filters.</div>
        ) : (
          <VirtualList
            listRef={resolvedListRef}
            style={{ height, width: '100%' }}
            rowCount={entries.length}
            rowHeight={(index: number) => getItemSize(index)}
            overscanCount={12}
            rowProps={data}
            rowComponent={(props: { index: number; style: React.CSSProperties }) =>
              renderRow({ ...props, ...data })
            }
          />
        )}
      </div>
    </div>
  );
}
