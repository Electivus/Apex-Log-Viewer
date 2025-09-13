import React, { useRef } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ApexLogRow } from '../../shared/types';
import { LogsHeader } from './table/LogsHeader';
import { LogRow } from './table/LogRow';
import { useAdaptiveList } from '../utils/useAdaptiveList';

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
  const {
    outerRef,
    height: measuredListHeight,
    getItemSize,
    setRowHeight,
    overscanCount,
    onRowsRendered
  } = useAdaptiveList({
    listRef,
    defaultRowHeight: 32,
    itemCount: rows.length,
    hasMore,
    loading,
    onLoadMore,
    headerRef
  });
  const gridTemplate =
    'minmax(160px,1fr) minmax(140px,1fr) minmax(200px,1.2fr) minmax(200px,1fr) minmax(110px,0.6fr) minmax(120px,0.8fr) minmax(260px,1.4fr) minmax(90px,0.6fr) 72px';
  // Header is rendered by LogsHeader; keep container simple

  // No additional effects required here; hook manages paging and overscan

  return (
    <div ref={outerRef} style={{ overflow: 'hidden' }}>
      <LogsHeader ref={headerRef} t={t} sortBy={sortBy} sortDir={sortDir} onSort={onSort} gridTemplate={gridTemplate} />
      <List
        style={{ height: measuredListHeight, width: '100%' }}
        rowCount={rows.length}
        rowHeight={(index: number) => getItemSize(index)}
        listRef={listRef}
        rowProps={{}}
        onRowsRendered={onRowsRendered}
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
