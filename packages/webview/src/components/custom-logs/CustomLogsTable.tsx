import React, { useMemo } from 'react';
import { List } from 'react-window';
import { TriangleAlert } from 'lucide-react';
import type { CustomLogRow } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { SortState, StandardColumnField, TableColumn } from '../../utils/customLogs/columns';
import { formatLogTime } from '../../utils/customLogs/format';
import type { DiscoveredField } from '../../utils/customLogs/payloadRows';
import { CustomLogsColumnsHeader, columnGrid } from './CustomLogsColumnsHeader';
import { ExtraCell } from './ExtraCell';
import { LevelBadge } from './LevelBadge';
import { PayloadCell } from './PayloadCell';
import { SCROLLBAR_GUTTER } from '../table/useVirtualListElement';
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

function TitleCell({ t, row }: { t: CustomLogsMessages; row: CustomLogRow }) {
  const payloadWarning =
    row.payload && row.payload.state !== 'parsed' && row.payload.state !== 'empty' ? row.payload.state : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1" title={row.title}>
      {payloadWarning ? (
        <span title={t.payload[`${payloadWarning}Note`]}>
          <TriangleAlert className="h-3 w-3 shrink-0 text-amber-400" aria-label={t.payload[payloadWarning]} />
        </span>
      ) : null}
      <span className="truncate">{row.title ?? row.id}</span>
    </span>
  );
}

function TextCell({ value }: { value: string | undefined }) {
  return (
    <span className="block truncate" title={value}>
      {value ?? ''}
    </span>
  );
}

function StandardCell({ t, row, field }: { t: CustomLogsMessages; row: CustomLogRow; field: StandardColumnField }) {
  switch (field) {
    case 'time':
      return <span className="font-mono text-[11px] text-muted-foreground">{formatLogTime(row.time)}</span>;
    case 'level':
      return <LevelBadge level={row.level} />;
    case 'title':
      return <TitleCell t={t} row={row} />;
    case 'origin':
      return <TextCell value={row.origin} />;
    case 'user':
      return <TextCell value={row.user} />;
    case 'log':
      return <TextCell value={row.log?.title} />;
  }
}

function RowCell({
  t,
  row,
  column,
  marker
}: {
  t: CustomLogsMessages;
  row: CustomLogRow;
  column: TableColumn;
  /** The first JSON column says why a payload has no values. */
  marker: boolean;
}) {
  switch (column.kind) {
    case 'std':
      return <StandardCell t={t} row={row} field={column.field} />;
    case 'extra':
      return <ExtraCell value={row.extra[column.key]} />;
    case 'log':
      return <ExtraCell value={row.log?.extra[column.key]} />;
    case 'payload':
      return <PayloadCell t={t} payload={row.payload} path={column.path} marker={marker} />;
  }
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
          <RowCell t={t} row={row} column={column} marker={column.id === firstPayloadColumnId} />
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
  virtualListComponent
}: CustomLogsTableProps) {
  const VirtualList = virtualListComponent ?? List;
  const { listRef, setListRef, headerRef, onKeyDown } = useGridList(rows, selectedId, onSelect, onOpen);
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
      />
      <div className="relative min-h-0 flex-1">
        <VirtualList
          listRef={setListRef}
          className={SCROLLBAR_GUTTER}
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
