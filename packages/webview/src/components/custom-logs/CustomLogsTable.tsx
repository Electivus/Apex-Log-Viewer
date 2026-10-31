import React, { useMemo } from 'react';
import { List } from 'react-window';
import { TriangleAlert } from 'lucide-react';
import type { CustomLogRow } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { SortState, TableColumn } from '../../utils/customLogs/columns';
import { formatLogTime } from '../../utils/customLogs/format';
import type { DiscoveredField } from '../../utils/customLogs/payloadRows';
import { CustomLogsColumnsHeader, columnGrid } from './CustomLogsColumnsHeader';
import { ExtraCell } from './ExtraCell';
import { LevelBadge } from './LevelBadge';
import { PayloadCell } from './PayloadCell';
import { useGridList } from './useGridList';
import { useLiveAnchor } from './useLiveAnchor';

const ROW_HEIGHT = 24;

type CustomLogsTableProps = {
  t: CustomLogsMessages;
  rows: readonly CustomLogRow[];
  columns: readonly TableColumn[];
  sort: SortState | undefined;
  selectedId: string | undefined;
  /** Every payload path seen in the loaded rows, for the `+ Field` picker. */
  discovered: readonly DiscoveredField[];
  activeColumns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onSort: (columnId: string, dir?: 'asc' | 'desc') => void;
  onSelect: (row: CustomLogRow) => void;
  onOpen: (row: CustomLogRow) => void;
  onToggleColumn: (path: string) => void;
  onRemoveColumn: (path: string) => void;
  onFilterBy: (path: string) => void;
  virtualListComponent?: typeof List;
};

type RowProps = {
  t: CustomLogsMessages;
  rows: readonly CustomLogRow[];
  columns: readonly TableColumn[];
  gridTemplate: string;
  totalWidth: number;
  selectedId: string | undefined;
  firstPayloadColumnId: string | undefined;
  onSelect: (row: CustomLogRow) => void;
  onOpen: (row: CustomLogRow) => void;
};

function CountsCell({ t, row }: { t: CustomLogsMessages; row: CustomLogRow }) {
  const counts = row.counts;
  if (!counts || counts.entries === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs">{counts.entries}</span>
      {counts.errors ? (
        <span
          className="rounded-full bg-[color-mix(in_srgb,var(--vscode-charts-red,#f14c4c)_20%,transparent)] px-1.5 text-[10px] leading-[15px] text-[color:var(--vscode-charts-red,#f14c4c)]"
          title={`${counts.errors} ${t.columns.errors}`}
        >
          {counts.errors}
        </span>
      ) : null}
      {counts.warnings ? (
        <span
          className="rounded-full bg-[color-mix(in_srgb,var(--vscode-charts-yellow,#cca700)_20%,transparent)] px-1.5 text-[10px] leading-[15px] text-[color:var(--vscode-charts-yellow,#cca700)]"
          title={`${counts.warnings} ${t.columns.warnings}`}
        >
          {counts.warnings}
        </span>
      ) : null}
    </span>
  );
}

function CustomLogRowView({
  index,
  style,
  t,
  rows,
  columns,
  gridTemplate,
  totalWidth,
  selectedId,
  firstPayloadColumnId,
  onSelect,
  onOpen
}: RowProps & { index: number; style: React.CSSProperties }) {
  const row = rows[index];
  if (!row) {
    return null;
  }
  const selected = row.id === selectedId;
  const payloadWarning =
    row.payload && row.payload.state !== 'parsed' && row.payload.state !== 'empty' ? row.payload.state : undefined;
  return (
    <div
      role="row"
      aria-selected={selected}
      aria-rowindex={index + 1}
      data-row-id={row.id}
      style={{ ...style, display: 'grid', gridTemplateColumns: gridTemplate, minWidth: totalWidth }}
      className={cn(
        'cursor-pointer items-center border-b border-border/40 text-xs hover:bg-muted/40',
        selected &&
          'bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))] hover:bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))]'
      )}
      onClick={() => onSelect(row)}
      onDoubleClick={() => onOpen(row)}
    >
      {columns.map(column => (
        <div key={column.id} role="gridcell" className="min-w-0 truncate px-2">
          {column.kind === 'std' ? (
            column.field === 'time' ? (
              <span className="font-mono text-[11px] text-muted-foreground">{formatLogTime(row.time)}</span>
            ) : column.field === 'level' ? (
              <LevelBadge level={row.level} />
            ) : column.field === 'title' ? (
              <span className="flex min-w-0 items-center gap-1" title={row.title}>
                {payloadWarning ? (
                  <span title={t.payload[`${payloadWarning}Note`]}>
                    <TriangleAlert className="h-3 w-3 shrink-0 text-amber-400" aria-label={t.payload[payloadWarning]} />
                  </span>
                ) : null}
                <span className="truncate">{row.title ?? row.id}</span>
              </span>
            ) : column.field === 'user' ? (
              <span className="truncate" title={row.user}>
                {row.user ?? ''}
              </span>
            ) : (
              <CountsCell t={t} row={row} />
            )
          ) : column.kind === 'extra' ? (
            <ExtraCell value={row.extra[column.key]} />
          ) : (
            <PayloadCell t={t} payload={row.payload} path={column.path} marker={column.id === firstPayloadColumnId} />
          )}
        </div>
      ))}
      <div />
    </div>
  );
}

export function CustomLogsTable({
  t,
  rows,
  columns,
  sort,
  selectedId,
  discovered,
  activeColumns,
  lockedColumns,
  onSort,
  onSelect,
  onOpen,
  onToggleColumn,
  onRemoveColumn,
  onFilterBy,
  virtualListComponent
}: CustomLogsTableProps) {
  const VirtualList = virtualListComponent ?? List;
  const { listRef, headerRef, onKeyDown } = useGridList(rows, selectedId, onSelect, onOpen);
  useLiveAnchor(rows, ROW_HEIGHT, listRef);

  const { gridTemplate, totalWidth } = useMemo(() => columnGrid(columns), [columns]);
  const firstPayloadColumnId = useMemo(() => columns.find(column => column.kind === 'payload')?.id, [columns]);

  const rowProps = useMemo<RowProps>(
    () => ({ t, rows, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, onOpen }),
    [t, rows, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, onOpen]
  );

  return (
    <div
      role="grid"
      aria-label={t.table.aria}
      aria-rowcount={rows.length}
      tabIndex={0}
      className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-none"
      onKeyDown={onKeyDown}
    >
      <CustomLogsColumnsHeader
        headerRef={headerRef}
        t={t}
        columns={columns}
        gridTemplate={gridTemplate}
        totalWidth={totalWidth}
        sort={sort}
        loadedCount={rows.length}
        discovered={discovered}
        activeColumns={activeColumns}
        lockedColumns={lockedColumns}
        onSort={onSort}
        onToggleColumn={onToggleColumn}
        onRemoveColumn={onRemoveColumn}
        onFilterBy={onFilterBy}
      />
      <div className="relative min-h-0 flex-1">
        <VirtualList
          listRef={listRef}
          style={{ height: '100%', width: '100%' }}
          rowCount={rows.length}
          rowHeight={ROW_HEIGHT}
          overscanCount={10}
          rowProps={rowProps}
          rowComponent={CustomLogRowView}
        />
      </div>
    </div>
  );
}
