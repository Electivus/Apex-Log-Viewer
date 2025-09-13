import React, { useRef, useState, useLayoutEffect } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import InfiniteLoader from 'react-window-infinite-loader';
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
  sortBy: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';
  sortDir: 'asc' | 'desc';
  onSort: (
    key: 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit'
  ) => void;
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
  const overscanCount = 8;
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(110px,0.6fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) 72px';
  // Header is rendered by LogsHeader; keep container simple

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

  const itemCount = hasMore ? rows.length + 1 : rows.length;
  const isItemLoaded = (index: number) => index < rows.length || loading;

  return (
    <div ref={outerRef} style={{ overflow: 'hidden' }}>
      <LogsHeader ref={headerRef} t={t} sortBy={sortBy} sortDir={sortDir} onSort={onSort} gridTemplate={gridTemplate} />
      <InfiniteLoader
        isItemLoaded={isItemLoaded}
        itemCount={itemCount}
        loadMoreItems={onLoadMore}
        threshold={overscanCount}
      >
        {({ onItemsRendered, ref }: { onItemsRendered: (info: any) => void; ref: React.Ref<ListImperativeAPI> }) => (
          <List
            style={{ height: measuredListHeight, width: '100%' }}
            rowCount={itemCount}
            rowHeight={(index: number) => getItemSize(index)}
            listRef={(instance: ListImperativeAPI | null) => {
              listRef.current = instance;
              if (typeof ref === 'function') ref(instance);
              else if (ref) (ref as any).current = instance;
            }}
            rowProps={{}}
            onRowsRendered={({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) =>
              onItemsRendered({
                overscanStartIndex: startIndex,
                overscanStopIndex: stopIndex + overscanCount,
                visibleStartIndex: startIndex,
                visibleStopIndex: stopIndex
              })
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
        )}
      </InfiniteLoader>
    </div>
  );
}
