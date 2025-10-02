import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ApexLogRow } from '../../shared/types';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';

export type LogHeadMap = Record<string, { codeUnitStarted?: string }>;

type ListRowProps = {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
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
  hasMore,
  onLoadMore,
  sortBy,
  sortDir,
  onSort,
  virtualListComponent,
  autoLoadEnabled = true
}: {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  matchSnippets: Record<string, { text: string; ranges: [number, number][] }>;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  loading: boolean;
  locale: string;
  hasMore: boolean;
  onLoadMore: () => void;
  sortBy: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';
  sortDir: 'asc' | 'desc';
  onSort: (
    key: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit'
  ) => void;
  virtualListComponent?: typeof List;
  autoLoadEnabled?: boolean;
}) {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  // Previously we gated auto-paging until the first scroll; this
  // prevented initial loads on small lists. After dependency updates,
  // relying on that gate causes missed load-more events. Remove the gate
  // and trigger based solely on visibility + hasMore/loading guards.
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
  // Track latest paging flags for scroll handler without re-binding listeners
  const hasMoreRef = useRef<boolean>(hasMore);
  const loadingRef = useRef<boolean>(loading);
  const autoLoadRef = useRef<boolean>(autoLoadEnabled);
  const onLoadMoreRef = useRef(onLoadMore);
  const lastLoadTsRef = useRef<number>(0);
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(110px,0.6fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) minmax(320px,1.6fr) 96px';
  // Header is rendered by LogsHeader; keep container simple

  // autoPagingActivated will be flipped by the adaptive overscan listener below

  const handleRowsRendered = (props: { startIndex: number; stopIndex: number }) => {
    const { stopIndex: visibleStopIndex } = props;
    const approxVisible = Math.max(5, Math.ceil(measuredListHeight / defaultRowHeight));
    if (!autoLoadEnabled || !hasMore || loading) {
      return;
    }
    if (!Number.isFinite(visibleStopIndex) || visibleStopIndex < 0) {
      return;
    }
    const threshold = Math.max(0, rows.length - (approxVisible + 5));
    if (visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

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
    () => ({ rows, logHead, matchSnippets, locale, t, loading, onOpen, onReplay, gridTemplate, setRowHeight }),
    [rows, logHead, matchSnippets, locale, t, loading, onOpen, onReplay, gridTemplate, setRowHeight]
  );

  const renderRow = useCallback(({
    index,
    style,
    rows: rowList,
    logHead: logHeadMap,
    matchSnippets: snippetMap,
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

  // Keep refs synchronized with latest props for scroll safety net
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    autoLoadRef.current = autoLoadEnabled;
  }, [autoLoadEnabled]);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  // Adaptive overscan based on scroll velocity
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const onScroll = () => {
      const now = performance.now();
      const dt = now - (overscanLastTsRef.current || now);
      const dy = Math.abs(el.scrollTop - (overscanLastTopRef.current || 0));
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
      // Also trigger load-more when very near the bottom, as a safety net
      if (
        autoLoadRef.current &&
        hasMoreRef.current &&
        !loadingRef.current &&
        el.scrollHeight > el.clientHeight
      ) {
        const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (remaining <= defaultRowHeight * 2) {
          if (now - lastLoadTsRef.current > 300) {
            lastLoadTsRef.current = now;
            onLoadMoreRef.current?.();
          }
        }
      }
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div ref={outerRef} className="relative overflow-hidden">
      <LogsHeader ref={headerRef} t={t} sortBy={sortBy} sortDir={sortDir} onSort={onSort} gridTemplate={gridTemplate} />
      <VirtualList
        style={{ height: measuredListHeight, width: '100%' }}
        rowCount={rows.length}
        rowHeight={(index: number) => getItemSize(index)}
        listRef={listRef}
        rowProps={listRowProps}
        onRowsRendered={({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) =>
          handleRowsRendered({ startIndex, stopIndex })
        }
        overscanCount={overscanCount}
        rowComponent={renderRow}
      />
    </div>
  );
}
