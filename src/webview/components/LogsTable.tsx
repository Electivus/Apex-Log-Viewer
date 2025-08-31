import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { VariableSizeList, ListOnItemsRenderedProps } from 'react-window';
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
  const listOuterRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<VariableSizeList | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [autoPagingActivated, setAutoPagingActivated] = useState(false);
  const defaultRowHeight = 32;
  const rowHeightsRef = useRef<Record<number, number>>({});
  const [measuredListHeight, setMeasuredListHeight] = useState<number>(420);
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) 72px';
  // Header is rendered by LogsHeader; keep container simple

  useEffect(() => {
    const el = listOuterRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      if (el.scrollTop > 0 && !autoPagingActivated) {
        setAutoPagingActivated(true);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [autoPagingActivated]);

  const handleItemsRendered = (props: ListOnItemsRenderedProps) => {
    const { visibleStopIndex } = props;
    // Trigger load more when within ~one screenful from the end
    const approxVisible = Math.max(5, Math.ceil(measuredListHeight / defaultRowHeight));
    const threshold = Math.max(0, rows.length - (approxVisible + 5));
    if (autoPagingActivated && hasMore && !loading && visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

  const setRowHeight = (index: number, size: number) => {
    const current = rowHeightsRef.current[index] ?? defaultRowHeight;
    const next = Math.max(defaultRowHeight, Math.ceil(size));
    if (current !== next) {
      rowHeightsRef.current[index] = next;
      // Recompute sizes from this index forward
      listRef.current?.resetAfterIndex(index);
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
      } catch {}
      window.removeEventListener('resize', recompute);
    };
  }, []);

  return (
    <div ref={outerRef} style={{ overflow: 'hidden' }}>
      <LogsHeader ref={headerRef} t={t} sortBy={sortBy} sortDir={sortDir} onSort={onSort} gridTemplate={gridTemplate} />
      <VariableSizeList
        height={measuredListHeight}
        width={'100%'}
        itemCount={rows.length}
        estimatedItemSize={defaultRowHeight}
        itemSize={getItemSize}
        outerRef={listOuterRef}
        ref={listRef}
        onItemsRendered={handleItemsRendered}
      >
        {({ index, style }) => (
          <LogRow
            r={rows[index]}
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
        )}
      </VariableSizeList>
    </div>
  );
}
