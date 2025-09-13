import React, { useEffect, useRef } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ApexLogRow } from '../../shared/types';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';
import { useVirtualList } from '../utils/useVirtualList';

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
  sortBy: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';
  sortDir: 'asc' | 'desc';
  onSort: (
    key: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit'
  ) => void;
}) {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const defaultRowHeight = 32;
  const { outerRef, height: measuredListHeight, setRowHeight, getItemSize, overscanCount } =
    useVirtualList({ listRef, defaultRowHeight, headerRef });
  // Track latest paging flags for scroll handler without re-binding listeners
  const hasMoreRef = useRef<boolean>(hasMore);
  const loadingRef = useRef<boolean>(loading);
  const lastLoadTsRef = useRef<number>(0);
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(110px,0.6fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) 72px';
  // Header is rendered by LogsHeader; keep container simple

  const handleRowsRendered = (props: { startIndex: number; stopIndex: number }) => {
    const { stopIndex: visibleStopIndex } = props;
    // Trigger load more when within ~one screenful from the end
    const approxVisible = Math.max(5, Math.ceil(measuredListHeight / defaultRowHeight));
    const threshold = Math.max(0, rows.length - (approxVisible + 5));
    if (hasMore && !loading && visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

  // Keep refs synchronized with latest props for scroll safety net
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  // Trigger load-more when scrolled near the bottom as a safety net
  useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const onScroll = () => {
      if (hasMoreRef.current && !loadingRef.current) {
        const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (remaining <= defaultRowHeight * 2) {
          const now = performance.now();
          if (now - lastLoadTsRef.current > 300) {
            lastLoadTsRef.current = now;
            onLoadMore();
          }
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

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
