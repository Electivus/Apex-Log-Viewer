import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { DataColumn, SortState } from '../../utils/customLogs/columns';
import { fillTemplate } from '../../utils/customLogs/format';
import type { DiscoveredField, PayloadFieldType } from '../../utils/customLogs/payloadRows';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { PAYLOAD_TYPE_LABEL_KEY, PayloadFieldPicker } from './PayloadFieldPicker';

export const ADD_FIELD_WIDTH = 96;

export type HeaderColumn = DataColumn<string>;

export function columnTrack(column: HeaderColumn): string {
  return 'flex' in column && column.flex ? `minmax(${column.width}px, 1fr)` : `${column.width}px`;
}

export function columnGrid(columns: readonly HeaderColumn[]): { gridTemplate: string; totalWidth: number } {
  return {
    gridTemplate: [...columns.map(columnTrack), `${ADD_FIELD_WIDTH}px`].join(' '),
    totalWidth: columns.reduce((sum, column) => sum + column.width, ADD_FIELD_WIDTH)
  };
}

const HEADER_CELL =
  'group/header flex min-w-0 items-center gap-1 border-r border-border/50 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground';

type CustomLogsColumnsHeaderProps = {
  t: CustomLogsMessages;
  columns: readonly HeaderColumn[];
  gridTemplate: string;
  totalWidth: number;
  sort: SortState | undefined;
  /** Loaded rows (or entries), for the "in N of M loaded" tooltip. */
  loadedCount: number;
  discovered: readonly DiscoveredField[];
  activeColumns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onSort: (columnId: string, dir?: 'asc' | 'desc') => void;
  onToggleColumn: (path: string) => void;
  onRemoveColumn: (path: string) => void;
  onFilterBy: (path: string) => void;
  headerRef?: React.Ref<HTMLDivElement>;
};

/** The header row both lists share: sortable cells, the JSON column menu and the `+ Field` picker. */
export function CustomLogsColumnsHeader({
  t,
  columns,
  gridTemplate,
  totalWidth,
  sort,
  loadedCount,
  discovered,
  activeColumns,
  lockedColumns,
  onSort,
  onToggleColumn,
  onRemoveColumn,
  onFilterBy,
  headerRef
}: CustomLogsColumnsHeaderProps) {
  return (
    <div ref={headerRef} role="row" className="shrink-0 overflow-hidden border-b border-border bg-card/70">
      <div
        style={{ display: 'grid', gridTemplateColumns: gridTemplate, minWidth: totalWidth }}
        className="h-6 items-stretch"
      >
        {columns.map(column => {
          const sorted = sort?.columnId === column.id;
          const type = column.kind === 'payload' && column.type ? t.picker[PAYLOAD_TYPE_LABEL_KEY[column.type]] : '';
          return (
            <div
              key={column.id}
              role="columnheader"
              aria-sort={!sorted ? 'none' : sort.dir === 'asc' ? 'ascending' : 'descending'}
              className={HEADER_CELL}
              title={
                column.kind === 'payload'
                  ? fillTemplate(t.table.payloadColumn, {
                      path: column.path,
                      type,
                      rows: column.rows ?? 0,
                      total: loadedCount
                    })
                  : column.label
              }
            >
              <button
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1 text-left',
                  column.kind === 'payload' && 'font-mono'
                )}
                onClick={() => onSort(column.id)}
              >
                {column.kind === 'payload' ? (
                  <i className="font-mono text-[10px] not-italic text-amber-400">{'{}'}</i>
                ) : null}
                <span className="truncate">{column.label}</span>
                {sorted ? (
                  sort.dir === 'asc' ? (
                    <ArrowUp
                      className="h-3 w-3 shrink-0 text-[color:var(--vscode-focusBorder,#3794ff)]"
                      aria-label={t.table.sortedAscending}
                    />
                  ) : (
                    <ArrowDown
                      className="h-3 w-3 shrink-0 text-[color:var(--vscode-focusBorder,#3794ff)]"
                      aria-label={t.table.sortedDescending}
                    />
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
          <PayloadFieldPicker
            t={t}
            fields={discovered}
            columns={activeColumns}
            lockedColumns={lockedColumns}
            onToggleColumn={onToggleColumn}
          >
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
  );
}
