import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';
import type { CustomLogEntry } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { SortState } from '../../utils/customLogs/columns';
import type { EntryColumn } from '../../utils/customLogs/entries';
import { formatClock } from '../../utils/customLogs/format';
import type { DiscoveredField } from '../../utils/customLogs/payloadRows';
import { CustomLogsColumnsHeader, columnGrid } from './CustomLogsColumnsHeader';
import { ExtraCell } from './ExtraCell';
import { LevelBadge } from './LevelBadge';
import { PayloadCell } from './PayloadCell';
import { useGridList } from './useGridList';

const DEFAULT_ROW_HEIGHT = 26;

type EntryRowProps = {
  t: CustomLogsMessages;
  entries: readonly CustomLogEntry[];
  columns: readonly EntryColumn[];
  gridTemplate: string;
  totalWidth: number;
  selectedId: string | undefined;
  firstPayloadColumnId: string | undefined;
  onSelect: (entry: CustomLogEntry) => void;
  setRowHeight: (index: number, size: number) => void;
};

function detailLabel(key: string): string {
  return key.replace(/__c$/, '');
}

function EntryRowView({
  index,
  style,
  t,
  entries,
  columns,
  gridTemplate,
  totalWidth,
  selectedId,
  firstPayloadColumnId,
  onSelect,
  setRowHeight
}: EntryRowProps & { index: number; style: React.CSSProperties }) {
  const entry = entries[index];
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setRowHeight(index, Math.ceil(element.scrollHeight) + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      try {
        observer.disconnect();
      } catch (e) {
        console.warn('CustomLogEntryList: failed to disconnect ResizeObserver', e);
      }
    };
  }, [entry, index, setRowHeight]);
  if (!entry) {
    return null;
  }
  const selected = entry.id === selectedId;
  return (
    <div style={style}>
      <div
        ref={ref}
        role="row"
        aria-selected={selected}
        data-entry-id={entry.id}
        style={{ display: 'grid', gridTemplateColumns: gridTemplate, minWidth: totalWidth }}
        className={cn(
          'cursor-pointer items-start border-b border-border/40 py-[3px] text-xs hover:bg-muted/40',
          entry.system && 'opacity-60',
          selected &&
            'bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))] hover:bg-[var(--vscode-list-activeSelectionBackground,rgba(4,57,94,0.9))]'
        )}
        onClick={() => onSelect(entry)}
      >
        {columns.map(column => (
          <div key={column.id} role="gridcell" className="min-w-0 px-2">
            {column.kind === 'std' ? (
              column.field === 'sequence' ? (
                <span className="font-mono text-[11px] text-muted-foreground">{entry.sequence}</span>
              ) : column.field === 'time' ? (
                <span className="font-mono text-[11px] text-muted-foreground" title={entry.time}>
                  {formatClock(entry.time)}
                </span>
              ) : column.field === 'level' ? (
                <LevelBadge level={entry.level} rawLevel={entry.rawLevel} />
              ) : column.field === 'origin' ? (
                <span className="block truncate" title={entry.origin}>
                  {entry.origin ?? ''}
                </span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  <span
                    className="line-clamp-4 whitespace-pre-wrap break-words"
                    title={entry.previewClipped ? t.viewer.entry.clipped : undefined}
                  >
                    {entry.message}
                    {entry.previewClipped || entry.messageTruncated ? (
                      <span className="text-muted-foreground"> …</span>
                    ) : null}
                  </span>
                  {entry.presentDetails.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {entry.presentDetails.map(key => (
                        <span
                          key={key}
                          title={key}
                          className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
                        >
                          {detailLabel(key)}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
              )
            ) : column.kind === 'extra' ? (
              <ExtraCell value={entry.extra[column.key]} />
            ) : (
              <PayloadCell
                t={t}
                payload={entry.payload}
                path={column.path}
                marker={column.id === firstPayloadColumnId}
              />
            )}
          </div>
        ))}
        <div />
      </div>
    </div>
  );
}

type CustomLogEntryListProps = {
  t: CustomLogsMessages;
  entries: readonly CustomLogEntry[];
  columns: readonly EntryColumn[];
  sort: SortState | undefined;
  selectedId: string | undefined;
  discovered: readonly DiscoveredField[];
  activeColumns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onSort: (columnId: string, dir?: 'asc' | 'desc') => void;
  onSelect: (entry: CustomLogEntry) => void;
  onToggleColumn: (path: string) => void;
  onRemoveColumn: (path: string) => void;
  onFilterBy: (path: string) => void;
  virtualListComponent?: typeof List;
};

/** The entries of one transaction, following the LogEntryList pattern: measured row heights over a virtual list. */
export function CustomLogEntryList({
  t,
  entries,
  columns,
  sort,
  selectedId,
  discovered,
  activeColumns,
  lockedColumns,
  onSort,
  onSelect,
  onToggleColumn,
  onRemoveColumn,
  onFilterBy,
  virtualListComponent
}: CustomLogEntryListProps) {
  const VirtualList = virtualListComponent ?? List;
  const { listRef, headerRef, onKeyDown } = useGridList(entries, selectedId, onSelect);
  const rowHeightsRef = useRef<Record<number, number>>({});
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);

  const { gridTemplate, totalWidth } = useMemo(() => columnGrid(columns), [columns]);
  const firstPayloadColumnId = useMemo(() => columns.find(column => column.kind === 'payload')?.id, [columns]);

  const setRowHeight = useCallback((index: number, size: number) => {
    const next = Math.max(DEFAULT_ROW_HEIGHT, Math.ceil(size));
    if (rowHeightsRef.current[index] !== next) {
      rowHeightsRef.current[index] = next;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          forceRender(value => value + 1);
        });
      }
    }
  }, []);

  // Heights belong to positions, so a new order or a new set of rows measures again.
  useEffect(() => {
    rowHeightsRef.current = {};
  }, [entries, columns]);

  const rowProps = useMemo<EntryRowProps>(
    () => ({ t, entries, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, setRowHeight }),
    [t, entries, columns, gridTemplate, totalWidth, selectedId, firstPayloadColumnId, onSelect, setRowHeight]
  );

  return (
    <div
      role="grid"
      aria-label={t.viewer.title}
      aria-rowcount={entries.length}
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
        loadedCount={entries.length}
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
          rowCount={entries.length}
          rowHeight={(index: number) => rowHeightsRef.current[index] ?? DEFAULT_ROW_HEIGHT}
          overscanCount={12}
          rowProps={rowProps}
          rowComponent={EntryRowView}
        />
      </div>
    </div>
  );
}
