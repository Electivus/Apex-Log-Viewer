import React, { useEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';
import type { ApexLogRow } from '@alv/protocol/types';
import type { LogsColumnKey, NormalizedLogsColumnsConfig } from '@alv/protocol/logsColumns';
import type { LogDiagnostic } from '@alv/protocol/logTriage';
import {
  LOG_ROW_HEIGHT_PX,
  LOGS_COLUMN_MIN_WIDTH_PX,
  buildLogsGrid,
  getVisibleLogsColumns
} from '../utils/logsColumns';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';
import { SCROLLBAR_GUTTER, syncHeaderScroll, useVirtualListElement } from './table/useVirtualListElement';

export type LogHeadEntry = {
  hasErrors?: boolean;
  primaryReason?: string;
  reasons?: LogDiagnostic[];
};

export type LogHeadMap = Record<string, LogHeadEntry>;

type ListRowProps = {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
  columns: LogsColumnKey[];
  locale: string;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  gridTemplate: string;
  minWidthPx: number;
};

type VirtualRowArgs = ListRowProps & {
  index: number;
  style: React.CSSProperties;
};

function VirtualLogRow({ index, style, rows, logHead, matchSnippets, ...rowProps }: VirtualRowArgs) {
  const row = rows[index];
  if (!row) return null;
  return <LogRow r={row} logHead={logHead} matchSnippet={matchSnippets[row.Id]} style={style} {...rowProps} />;
}

export function LogsTable({
  rows,
  logHead,
  matchSnippets,
  t,
  onOpen,
  onReplay,
  locale,
  sortBy,
  sortDir,
  onSort,
  columnsConfig,
  onColumnsConfigChange,
  virtualListComponent,
  fullLogSearchEnabled,
  hasSearchText,
  emptyMessage
}: {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  locale: string;
  sortBy: Exclude<LogsColumnKey, 'match'>;
  sortDir: 'asc' | 'desc';
  onSort: (key: Exclude<LogsColumnKey, 'match'>) => void;
  columnsConfig: NormalizedLogsColumnsConfig;
  onColumnsConfigChange: (
    updater: (prev: NormalizedLogsColumnsConfig) => NormalizedLogsColumnsConfig,
    options?: { persist?: boolean }
  ) => void;
  virtualListComponent?: typeof List;
  fullLogSearchEnabled: boolean;
  hasSearchText: boolean;
  /** Shown where the rows would be, so an empty list explains itself without scrolling. */
  emptyMessage?: string;
}) {
  const { setListRef, element: listElement } = useVirtualListElement();
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);
  const VirtualList = virtualListComponent ?? List;
  const columns = useMemo(
    () => getVisibleLogsColumns(columnsConfig, { fullLogSearchEnabled, hasSearchText }),
    [columnsConfig, fullLogSearchEnabled, hasSearchText]
  );
  const { gridTemplate, minWidthPx } = useMemo(
    () => buildLogsGrid(columns, columnsConfig.widths),
    [columns, columnsConfig.widths]
  );

  const listRowProps = useMemo<ListRowProps>(
    () => ({ rows, logHead, matchSnippets, columns, locale, t, onOpen, onReplay, gridTemplate, minWidthPx }),
    [rows, logHead, matchSnippets, columns, locale, t, onOpen, onReplay, gridTemplate, minWidthPx]
  );

  // Header follows the horizontal scroll; overscan adapts to scroll velocity
  useEffect(() => {
    const el = listElement;
    if (!el) return;
    syncHeaderScroll(el, headerRef.current);
    const onScroll = () => {
      const now = performance.now();
      const dt = now - (overscanLastTsRef.current || now);
      const dy = Math.abs(el.scrollTop - (overscanLastTopRef.current || 0));
      syncHeaderScroll(el, headerRef.current);
      if (dt > 16) {
        const v = dy / dt; // px per ms
        let next = overscanBaseRef.current;
        if (v > 2) next = 22;
        else if (v > 1) next = 14;
        else if (v > 0.4) next = 10;
        else next = overscanBaseRef.current; // idle/slow
        if (next !== overscanLastSetRef.current) {
          overscanLastSetRef.current = next;
          setOverscanCount(next);
        }
        if (overscanDecayRef.current) clearTimeout(overscanDecayRef.current);
        overscanDecayRef.current = setTimeout(() => {
          if (overscanLastSetRef.current !== overscanBaseRef.current) {
            overscanLastSetRef.current = overscanBaseRef.current;
            setOverscanCount(overscanBaseRef.current);
          }
        }, 200);
      }
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [listElement]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <LogsHeader
        ref={headerRef}
        t={t}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
        gridTemplate={gridTemplate}
        minWidthPx={minWidthPx}
        columns={columns}
        onResizeColumn={(key, widthPx, options) => {
          const minWidth = LOGS_COLUMN_MIN_WIDTH_PX[key];
          const clamped = Math.max(minWidth, Math.floor(widthPx));
          onColumnsConfigChange(prev => ({ ...prev, widths: { ...prev.widths, [key]: clamped } }), {
            persist: options.persist
          });
        }}
        onClearColumnWidth={key => {
          onColumnsConfigChange(prev => {
            const { [key]: _removed, ...rest } = prev.widths;
            return { ...prev, widths: rest };
          });
        }}
      />
      <div className="relative min-h-0 flex-1">
        <VirtualList
          className={SCROLLBAR_GUTTER}
          style={{ height: '100%', width: '100%' }}
          rowCount={rows.length}
          rowHeight={LOG_ROW_HEIGHT_PX}
          listRef={setListRef}
          rowProps={listRowProps}
          overscanCount={overscanCount}
          rowComponent={VirtualLogRow}
        />
        {emptyMessage && (
          <p
            data-testid="logs-empty-message"
            className="absolute inset-x-0 top-0 m-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
          >
            {emptyMessage}
          </p>
        )}
      </div>
    </div>
  );
}
