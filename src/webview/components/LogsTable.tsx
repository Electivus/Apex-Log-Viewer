import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ApexLogRow } from '../../shared/types';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';

export type LogHeadMap = Record<string, { codeUnitStarted?: string }>;

export function LogsTable({
  rows,
  logHead,
  t,
  onOpen,
  onReplay,
  loading,
  locale,
  hasMore,
  onLoadMore,
  sortBy,
  sortDir,
  onSort
}: {
  rows: ApexLogRow[];
  logHead: LogHeadMap;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  loading: boolean;
  locale: string;
  hasMore: boolean;
  onLoadMore: () => void;
  sortBy: 'user' | 'application' | 'operation' | 'time' | 'status' | 'size' | 'codeUnit';
  sortDir: 'asc' | 'desc';
  onSort: (key: 'user' | 'application' | 'operation' | 'time' | 'status' | 'size' | 'codeUnit') => void;
}) {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [autoPagingActivated, setAutoPagingActivated] = useState(false);
  const defaultRowHeight = 32;
  const rowHeightsRef = useRef<Record<number, number>>({});
  const [measuredListHeight, setMeasuredListHeight] = useState<number>(420);
  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) 72px';
  // Header is rendered by LogsHeader; keep container simple

  // autoPagingActivated will be flipped by the adaptive overscan listener below

  const handleRowsRendered = (props: { startIndex: number; stopIndex: number }) => {
    const { stopIndex: visibleStopIndex } = props;
    // Trigger load more when within ~one screenful from the end
    const approxVisible = Math.max(5, Math.ceil(measuredListHeight / defaultRowHeight));
    const threshold = Math.max(0, rows.length - (approxVisible + 5));
    if (autoPagingActivated && hasMore && !loading && visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

  // Batch resetAfterIndex calls to once-per-frame
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);
  const scheduleRerender = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender(v => v + 1);
    });
  };
  const setRowHeight = (index: number, size: number) => {
    const current = rowHeightsRef.current[index] ?? defaultRowHeight;
    const next = Math.max(defaultRowHeight, Math.ceil(size));
    if (current !== next) {
      rowHeightsRef.current[index] = next;
      scheduleRerender();
    }
  };

  const getItemSize = (index: number) => rowHeightsRef.current[index] ?? defaultRowHeight;

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
      if (el.scrollTop > 0 && !autoPagingActivated) setAutoPagingActivated(true);
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
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [autoPagingActivated]);

  return (
    <div ref={outerRef} style={{ overflow: 'hidden' }}>
      <LogsHeader ref={headerRef} t={t} sortBy={sortBy} sortDir={sortDir} onSort={onSort} gridTemplate={gridTemplate} />
      <List
        style={{ height: measuredListHeight, width: '100%' }}
        rowCount={rows.length}
        rowHeight={(index: number) => getItemSize(index)}
        listRef={listRef}
        rowProps={{}}
        onRowsRendered={({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) =>
          handleRowsRendered({ startIndex, stopIndex })
        }
        overscanCount={overscanCount}
        rowComponent={({ index, style }: { index: number; style: React.CSSProperties }) => {
          const row = rows[index];
          if (!row) return null;
          return (
            <LogRow
              r={row}
              logHead={logHead}
              locale={locale}
              t={t}
              loading={loading}
              onOpen={onOpen}
              onReplay={onReplay}
              gridTemplate={gridTemplate}
              style={style}
              index={index}
              setRowHeight={setRowHeight}
            />
          );
        }}
      />
    </div>
  );
}
