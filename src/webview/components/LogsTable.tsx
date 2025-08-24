import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { FixedSizeList, ListOnItemsRenderedProps } from 'react-window';
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
  const outerRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [autoPagingActivated, setAutoPagingActivated] = useState(false);
  const rowHeight = 32;
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
    const threshold = Math.max(0, rows.length - 10);
    if (autoPagingActivated && hasMore && !loading && visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

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
      <FixedSizeList
        height={measuredListHeight}
        width={'100%'}
        itemCount={rows.length}
        itemSize={rowHeight}
        outerRef={listOuterRef}
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
          />
        )}
      </FixedSizeList>
    </div>
  );
}
