import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DynamicRowHeight } from 'react-window';
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
import { GridScroller } from './CustomLogsGridScroller';
import { useGridList, type RevealRequest } from './useGridList';

const DEFAULT_ROW_HEIGHT = 26;

type EntryRowProps = {
  t: CustomLogsMessages;
  entries: readonly CustomLogEntry[];
  columns: readonly EntryColumn[];
  gridTemplate: string;
  selectedId: string | undefined;
  firstPayloadColumnId: string | undefined;
  onSelect: (entry: CustomLogEntry) => void;
};

function detailLabel(key: string): string {
  return key.replace(/__c$/, '');
}

const entryIdOf = (row: Element) => row.querySelector('[data-entry-id]')?.getAttribute('data-entry-id');

/**
 * Row heights in react-window's dynamic row height protocol, kept per entry so a filter or sort that moves a row
 * keeps its height. The virtualizer measures every row it renders through `observeRowElements`, and with dynamic
 * heights its `scrollToIndex` keeps following the row while the rows around it measure and the list resizes. A row not yet
 * measured counts DEFAULT_ROW_HEIGHT, not the average, so measuring the rows in view never moves them.
 */
function useEntryRowHeights(entries: readonly CustomLogEntry[]): DynamicRowHeight {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const observerRef = useRef<ResizeObserver | null>(null);

  const record = useCallback((measured: ReadonlyArray<readonly [string, number]>) => {
    setHeights(previous => {
      let next: Map<string, number> | undefined;
      for (const [entryId, size] of measured) {
        if ((next ?? previous).get(entryId) !== size) {
          next ??= new Map(previous);
          next.set(entryId, size);
        }
      }
      return next ?? previous;
    });
  }, []);

  const observeRowElements = useCallback(
    (elements: Element[] | NodeListOf<Element>) => {
      observerRef.current ??= new ResizeObserver(records =>
        record(
          records.flatMap(({ target, borderBoxSize }) => {
            const entryId = entryIdOf(target);
            const size = borderBoxSize[0]?.blockSize ?? 0;
            return entryId && size > 0 ? [[entryId, Math.ceil(size)] as const] : [];
          })
        )
      );
      const observer = observerRef.current;
      const rows = Array.from(elements);
      rows.forEach(row => observer.observe(row));
      return () => rows.forEach(row => observer.unobserve(row));
    },
    [record]
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return useMemo<DynamicRowHeight>(
    () => ({
      getAverageRowHeight: () => DEFAULT_ROW_HEIGHT,
      getRowHeight: index => heights.get(entries[index]?.id ?? ''),
      setRowHeight: (index, size) => {
        const entryId = entries[index]?.id;
        if (entryId) {
          record([[entryId, size]]);
        }
      },
      observeRowElements
    }),
    [entries, heights, observeRowElements, record]
  );
}

function EntryRowView({
  index,
  offset,
  measureElement,
  t,
  entries,
  columns,
  gridTemplate,
  selectedId,
  firstPayloadColumnId,
  onSelect
}: EntryRowProps & { index: number; offset: number; measureElement: (element: Element | null) => void }) {
  const entry = entries[index];
  if (!entry) {
    return null;
  }
  const selected = entry.id === selectedId;
  return (
    <div
      ref={measureElement}
      data-index={index}
      style={{ position: 'absolute', top: offset, left: 0, right: 0, minHeight: DEFAULT_ROW_HEIGHT }}
    >
      <div
        role="row"
        aria-selected={selected}
        aria-rowindex={index + 2}
        data-entry-id={entry.id}
        style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
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
  /** The entry the list opened, scrolled into view once it shows. */
  reveal?: RevealRequest;
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
  reveal
}: CustomLogEntryListProps) {
  const rowHeight = useEntryRowHeights(entries);
  const { setScroller, setBody, virtualItems, measureElement, totalSize, onKeyDown } = useGridList(
    entries,
    selectedId,
    onSelect,
    { itemSize: rowHeight, overscanCount: 12, reveal }
  );

  const { gridTemplate, totalWidth } = useMemo(() => columnGrid(columns), [columns]);
  const firstPayloadColumnId = useMemo(() => columns.find(column => column.kind === 'payload')?.id, [columns]);

  return (
    <div
      role="grid"
      aria-label={t.viewer.title}
      aria-rowcount={entries.length + 1}
      tabIndex={0}
      className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-none"
      onKeyDown={onKeyDown}
    >
      <GridScroller
        setScroller={setScroller}
        setBody={setBody}
        totalWidth={totalWidth}
        totalSize={totalSize}
        header={
          <CustomLogsColumnsHeader
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
          />
        }
      >
        {virtualItems.map(({ index, offset }) => (
          <EntryRowView
            key={entries[index]?.id ?? index}
            index={index}
            offset={offset}
            measureElement={measureElement}
            t={t}
            entries={entries}
            columns={columns}
            gridTemplate={gridTemplate}
            selectedId={selectedId}
            firstPayloadColumnId={firstPayloadColumnId}
            onSelect={onSelect}
          />
        ))}
      </GridScroller>
    </div>
  );
}
