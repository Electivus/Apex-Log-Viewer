import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ApexLogRow } from '../../shared/types';
import type { LogsColumnKey, NormalizedLogsColumnsConfig } from '../../shared/logsColumns';
import { LOGS_COLUMN_DEFAULT_TRACK, LOGS_COLUMN_MIN_WIDTH_PX } from '../utils/logsColumns';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';

export type LogHeadMap = Record<string, { codeUnitStarted?: string; hasErrors?: boolean }>;

type ListRowProps = {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
  columns: LogsColumnKey[];
  locale: string;
  t: any;
  loading: boolean;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  gridTemplate: string;
  setRowHeight: (index: number, size: number) => void;
};

type VirtualRowArgs = ListRowProps & {
  index: number;
  style: React.CSSProperties;
  ariaAttributes: {
    'aria-posinset': number;
    'aria-setsize': number;
    role: 'listitem';
  };
};

export function LogsTable({
  rows,
  logHead,
  matchSnippets,
  t,
  onOpen,
  onReplay,
  loading,
  locale,
  sortBy,
  sortDir,
  onSort,
  columnsConfig,
  onColumnsConfigChange,
  virtualListComponent,
  fullLogSearchEnabled
}: {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  loading: boolean;
  locale: string;
  sortBy: Exclude<LogsColumnKey, 'match'>;
  sortDir: 'asc' | 'desc';
  onSort: (
    key: Exclude<LogsColumnKey, 'match'>
  ) => void;
  columnsConfig: NormalizedLogsColumnsConfig;
  onColumnsConfigChange: (
    updater: (prev: NormalizedLogsColumnsConfig) => NormalizedLogsColumnsConfig,
    options?: { persist?: boolean }
  ) => void;
  virtualListComponent?: typeof List;
  fullLogSearchEnabled: boolean;
}) {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const defaultRowHeight = 32;
  const rowHeightsRef = useRef<Record<number, number>>({});
  const [measuredListHeight, setMeasuredListHeight] = useState<number>(420);
  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);
  const VirtualList = virtualListComponent ?? List;
  const columns = useMemo<LogsColumnKey[]>(() => {
    const visible = columnsConfig.order.filter(key => {
      if (!columnsConfig.visibility[key]) return false;
      if (key === 'match' && !fullLogSearchEnabled) return false;
      return true;
    });
    return visible;
  }, [columnsConfig.order, columnsConfig.visibility, fullLogSearchEnabled]);

  const flexColumn = useMemo<LogsColumnKey | undefined>(() => {
    const preferred: LogsColumnKey[] = [
      'operation',
      'match',
      'application',
      'user',
      'codeUnit',
      'time',
      'status',
      'duration',
      'size'
    ];
    return preferred.find(k => columns.includes(k));
  }, [columns]);

  const gridTemplate = useMemo(() => {
    const tracks = columns.map(key => {
      const minWidth = LOGS_COLUMN_MIN_WIDTH_PX[key] ?? 80;
      const rawWidth = columnsConfig.widths[key];
      const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? Math.floor(rawWidth) : undefined;
      const clamped = width !== undefined ? Math.max(minWidth, width) : undefined;
      if (key === flexColumn) {
        if (clamped !== undefined) return `minmax(${clamped}px, 1fr)`;
        return LOGS_COLUMN_DEFAULT_TRACK[key];
      }
      if (clamped !== undefined) return `${clamped}px`;
      return LOGS_COLUMN_DEFAULT_TRACK[key];
    });
    tracks.push('96px');
    return tracks.join(' ');
  }, [columns, columnsConfig.widths, flexColumn]);
  // Header is rendered by LogsHeader; keep container simple

  // Batch resetAfterIndex calls to once-per-frame
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);
  const scheduleRerender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender(v => v + 1);
    });
  }, []);
  const setRowHeight = useCallback((index: number, size: number) => {
    const current = rowHeightsRef.current[index] ?? defaultRowHeight;
    const next = Math.max(defaultRowHeight, Math.ceil(size));
    if (current !== next) {
      rowHeightsRef.current[index] = next;
      scheduleRerender();
    }
  }, [defaultRowHeight, scheduleRerender]);

  const getItemSize = (index: number) => rowHeightsRef.current[index] ?? defaultRowHeight;

  const listRowProps = useMemo<ListRowProps>(
    () => ({
      rows,
      logHead,
      matchSnippets,
      columns,
      locale,
      t,
      loading,
      onOpen,
      onReplay,
      gridTemplate,
      setRowHeight
    }),
    [
      rows,
      logHead,
      matchSnippets,
      columns,
      locale,
      t,
      loading,
      onOpen,
      onReplay,
      gridTemplate,
      setRowHeight
    ]
  );

  const renderRow = useCallback(({
    index,
    style,
    rows: rowList,
    logHead: logHeadMap,
    matchSnippets: snippetMap,
    columns: rowColumns,
    locale: rowLocale,
    t: messages,
    loading: isLoading,
    onOpen: handleOpen,
    onReplay: handleReplay,
    gridTemplate: template,
    setRowHeight: measureRowHeight
  }: VirtualRowArgs) => {
      const row = rowList[index];
      if (!row) return null;
      return (
        <LogRow
          r={row}
          logHead={logHeadMap}
          matchSnippet={snippetMap[row.Id]}
          columns={rowColumns}
          locale={rowLocale}
          t={messages}
          loading={isLoading}
          onOpen={handleOpen}
          onReplay={handleReplay}
          gridTemplate={template}
          style={style}
          index={index}
          setRowHeight={measureRowHeight}
        />
      );
    }, []);

  useLayoutEffect(() => {
    const recompute = () => {
      const outerRect = outerRef.current?.getBoundingClientRect();
      const headerRect = headerRef.current?.getBoundingClientRect();
      const top = outerRect?.top ?? 0;
      const headerH = headerRect?.height ?? 0;
      const available = Math.max(160, Math.floor(window.innerHeight - top - headerH - 12));
      setMeasuredListHeight(available);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (outerRef.current) {
      ro.observe(outerRef.current);
    }
    window.addEventListener('resize', recompute);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogsTable: failed to disconnect ResizeObserver', e);
      }
      window.removeEventListener('resize', recompute);
    };
  }, []);

  // Adaptive overscan based on scroll velocity
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const onScroll = () => {
      const now = performance.now();
      const dt = now - (overscanLastTsRef.current || now);
      const dy = Math.abs(el.scrollTop - (overscanLastTopRef.current || 0));
      if (headerRef.current && headerRef.current.scrollLeft !== el.scrollLeft) {
        headerRef.current.scrollLeft = el.scrollLeft;
      }
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
  }, []);

  return (
    <div ref={outerRef} className="relative overflow-hidden">
      <LogsHeader
        ref={headerRef}
        t={t}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
        gridTemplate={gridTemplate}
        columns={columns}
        onResizeColumn={(key, widthPx, options) => {
          const minWidth = LOGS_COLUMN_MIN_WIDTH_PX[key] ?? 80;
          const clamped = Math.max(minWidth, Math.floor(widthPx));
          onColumnsConfigChange(
            prev => ({ ...prev, widths: { ...prev.widths, [key]: clamped } }),
            { persist: options.persist }
          );
        }}
        onClearColumnWidth={key => {
          onColumnsConfigChange(prev => {
            const { [key]: _removed, ...rest } = prev.widths;
            return { ...prev, widths: rest };
          });
        }}
      />
      <VirtualList
        style={{ height: measuredListHeight, width: '100%' }}
        rowCount={rows.length}
        rowHeight={(index: number) => getItemSize(index)}
        listRef={listRef}
        rowProps={listRowProps}
        overscanCount={overscanCount}
        rowComponent={renderRow}
      />
    </div>
  );
}
