import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import type { CustomLogRow } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { SortState, TableColumn } from '../../utils/customLogs/columns';
import { fillTemplate, formatLogTime, formatScalar, scalarKind } from '../../utils/customLogs/format';
import { payloadValues, type DiscoveredField } from '../../utils/customLogs/payloadRows';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { LevelBadge } from './LevelBadge';
import { PAYLOAD_TYPE_LABEL_KEY, PayloadFieldPicker } from './PayloadFieldPicker';

const ROW_HEIGHT = 24;
const ADD_FIELD_WIDTH = 96;

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

function columnTrack(column: TableColumn): string {
  return 'flex' in column && column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`;
}

const HEADER_CELL = 'group/header flex min-w-0 items-center gap-1 border-r border-border/50 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground';

function CountsCell({ t, row }: { t: CustomLogsMessages; row: CustomLogRow }) {
  const counts = row.counts;
  if (!counts || counts.entries === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs">{counts.entries}</span>
      {counts.errors ? (
        <span className="rounded-full bg-[color-mix(in_srgb,var(--vscode-charts-red,#f14c4c)_20%,transparent)] px-1.5 text-[10px] leading-[15px] text-[color:var(--vscode-charts-red,#f14c4c)]" title={`${counts.errors} ${t.columns.errors}`}>
          {counts.errors}
        </span>
      ) : null}
      {counts.warnings ? (
        <span className="rounded-full bg-[color-mix(in_srgb,var(--vscode-charts-yellow,#cca700)_20%,transparent)] px-1.5 text-[10px] leading-[15px] text-[color:var(--vscode-charts-yellow,#cca700)]" title={`${counts.warnings} ${t.columns.warnings}`}>
          {counts.warnings}
        </span>
      ) : null}
    </span>
  );
}

function PayloadCell({ t, row, column, marker }: { t: CustomLogsMessages; row: CustomLogRow; column: Extract<TableColumn, { kind: 'payload' }>; marker: boolean }) {
  const values = payloadValues(row.payload, column.path);
  if (values.length > 0) {
    const single = values.length === 1 ? values[0]! : undefined;
    const kind = single === undefined ? 'string' : scalarKind(single);
    const text = values.map(formatScalar).join(', ');
    return (
      <span
        title={text}
        className={cn(
          'block truncate font-mono text-xs',
          kind === 'number' && 'text-right text-[color:var(--vscode-debugTokenExpression-number,#b5cea8)]',
          kind === 'boolean' && 'text-[color:var(--vscode-debugTokenExpression-boolean,#569cd6)]',
          kind === 'null' && 'italic text-muted-foreground'
        )}
      >
        {text}
      </span>
    );
  }
  const state = row.payload?.state;
  if (marker && state && state !== 'parsed') {
    return (
      <span className={cn('flex items-center gap-1 text-[11px]', state === 'empty' ? 'text-muted-foreground' : 'text-amber-400')} title={t.payload[`${state}Note`]}>
        {state === 'empty' ? null : <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {t.payload[state]}
      </span>
    );
  }
  return <span className="text-muted-foreground/60">—</span>;
}

function CustomLogRowView({ index, style, t, rows, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, onOpen }: RowProps & { index: number; style: React.CSSProperties }) {
  const row = rows[index];
  if (!row) {
    return null;
  }
  const selected = row.id === selectedId;
  const payloadWarning = row.payload && row.payload.state !== 'parsed' && row.payload.state !== 'empty' ? row.payload.state : undefined;
  return (
    <div
      role="row"
      aria-selected={selected}
      aria-rowindex={index + 1}
      data-row-id={row.id}
      style={{ ...style, display: 'grid', gridTemplateColumns: gridTemplate, minWidth: totalWidth }}
      className={cn(
        'cursor-pointer items-center border-b border-border/40 text-xs hover:bg-muted/40',
        selected && 'bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))] hover:bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))]'
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
            <span className="truncate" title={formatScalar(row.extra[column.key])}>
              {formatScalar(row.extra[column.key])}
            </span>
          ) : (
            <PayloadCell t={t} row={row} column={column} marker={column.id === firstPayloadColumnId} />
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
  const listRef = useRef<ListImperativeAPI | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  const gridTemplate = useMemo(() => [...columns.map(columnTrack), `${ADD_FIELD_WIDTH}px`].join(' '), [columns]);
  const totalWidth = useMemo(() => columns.reduce((sum, column) => sum + column.width, ADD_FIELD_WIDTH), [columns]);
  const firstPayloadColumnId = useMemo(() => columns.find(column => column.kind === 'payload')?.id, [columns]);

  useEffect(() => {
    const element = listRef.current?.element;
    if (!element) {
      return;
    }
    const syncHeader = () => {
      if (headerRef.current) {
        headerRef.current.scrollLeft = element.scrollLeft;
      }
    };
    element.addEventListener('scroll', syncHeader, { passive: true });
    return () => element.removeEventListener('scroll', syncHeader);
  }, []);

  const selectedIndex = rows.findIndex(row => row.id === selectedId);

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      const from = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : rows.length;
      const index = Math.min(rows.length - 1, Math.max(0, from + delta));
      const next = rows[index];
      if (next) {
        onSelect(next);
        listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'auto' });
      }
    },
    [onSelect, rows, selectedIndex]
  );

  const rowProps = useMemo<RowProps>(
    () => ({ t, rows, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, onOpen }),
    [t, rows, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, onOpen]
  );

  const ariaSort = (columnId: string): 'none' | 'ascending' | 'descending' =>
    sort?.columnId !== columnId ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending';

  return (
    <div
      role="grid"
      aria-label={t.table.aria}
      aria-rowcount={rows.length}
      tabIndex={0}
      className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-none"
      onKeyDown={event => {
        if (event.target !== event.currentTarget) {
          return;
        }
        const selected = rows[selectedIndex];
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(-1);
        } else if (event.key === 'Enter' && selected) {
          event.preventDefault();
          onOpen(selected);
        }
      }}
    >
      <div ref={headerRef} role="row" className="shrink-0 overflow-hidden border-b border-border bg-card/70">
        <div style={{ display: 'grid', gridTemplateColumns: gridTemplate, minWidth: totalWidth }} className="h-6 items-stretch">
          {columns.map(column => {
            const sorted = sort?.columnId === column.id;
            const type = column.kind === 'payload' && column.type ? t.picker[PAYLOAD_TYPE_LABEL_KEY[column.type]] : '';
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-sort={ariaSort(column.id)}
                className={cn(HEADER_CELL, column.kind === 'payload' ? 'normal-case' : 'uppercase')}
                title={
                  column.kind === 'payload'
                    ? fillTemplate(t.table.payloadColumn, { path: column.path, type, rows: column.rows ?? 0, total: rows.length })
                    : column.label
                }
              >
                <button
                  type="button"
                  className={cn('flex min-w-0 flex-1 items-center gap-1 text-left', column.kind === 'payload' && 'font-mono')}
                  onClick={() => onSort(column.id)}
                >
                  {column.kind === 'payload' ? <i className="font-mono text-[10px] not-italic text-amber-400">{'{}'}</i> : null}
                  <span className="truncate">{column.label}</span>
                  {sorted ? (
                    sort?.dir === 'asc' ? (
                      <ArrowUp className="h-3 w-3 shrink-0 text-[color:var(--vscode-focusBorder,#3794ff)]" aria-label={t.table.sortedAscending} />
                    ) : (
                      <ArrowDown className="h-3 w-3 shrink-0 text-[color:var(--vscode-focusBorder,#3794ff)]" aria-label={t.table.sortedDescending} />
                    )
                  ) : null}
                </button>
                {column.kind === 'payload' ? (
                  <ColumnHeaderMenu
                    t={t}
                    column={column.path}
                    locked={column.locked}
                    onSort={dir => onSort(column.id, dir)}
                    onFilter={() => onFilterBy(column.path)}
                    onRemove={() => onRemoveColumn(column.path)}
                  />
                ) : null}
              </div>
            );
          })}
          <div role="columnheader" className="flex items-center px-2">
            <PayloadFieldPicker t={t} fields={discovered} columns={activeColumns} lockedColumns={lockedColumns} onToggleColumn={onToggleColumn}>
              <button
                type="button"
                title={t.table.addFieldTitle}
                className="text-[11px] font-semibold text-[color:var(--vscode-textLink-foreground,#3794ff)] hover:underline"
              >
                {t.table.addField}
              </button>
            </PayloadFieldPicker>
          </div>
        </div>
      </div>
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
