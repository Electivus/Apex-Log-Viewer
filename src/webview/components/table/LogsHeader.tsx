import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { LogsColumnKey } from '../../../shared/logsColumns';
import { getLogsColumnLabel, LOGS_COLUMN_MIN_WIDTH_PX } from '../../utils/logsColumns';

type SortKey = Exclude<LogsColumnKey, 'match'>;

type Props = {
  t: any;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  gridTemplate: string;
  columns: LogsColumnKey[];
  onResizeColumn: (key: LogsColumnKey, widthPx: number, options: { persist: boolean }) => void;
  onClearColumnWidth: (key: LogsColumnKey) => void;
};

export const LogsHeader = React.forwardRef<HTMLDivElement, Props>(
  ({ t, sortBy, sortDir, onSort, gridTemplate, columns, onResizeColumn, onClearColumnWidth }, ref) => {
    const renderSortIcon = (key: SortKey) => {
      if (sortBy !== key) {
        return <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />;
      }
      return sortDir === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      );
    };

    const ariaSort = (key: SortKey): 'none' | 'ascending' | 'descending' => {
      if (sortBy !== key) return 'none';
      return sortDir === 'asc' ? 'ascending' : 'descending';
    };

    const headerClass =
      'flex items-center gap-1 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

    const isSortableColumn = (key: LogsColumnKey): key is SortKey => key !== 'match';

    const alignForColumn = (key: LogsColumnKey): 'start' | 'end' =>
      key === 'size' ? 'end' : 'start';

    const startResize = (key: LogsColumnKey, e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const handle = e.currentTarget;
      const cell = handle.parentElement as HTMLElement | null;
      if (!cell) return;

      const minWidth = LOGS_COLUMN_MIN_WIDTH_PX[key] ?? 80;
      const startX = e.clientX;
      const startWidth = cell.getBoundingClientRect().width;
      let lastWidth = Math.max(minWidth, Math.round(startWidth));

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const next = Math.max(minWidth, Math.round(startWidth + dx));
        lastWidth = next;
        onResizeColumn(key, next, { persist: false });
      };

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      const onUp = () => {
        onResizeColumn(key, lastWidth, { persist: true });
        cleanup();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    const renderColumnHeader = (key: LogsColumnKey) => {
      const label = getLogsColumnLabel(key, t);
      const align = alignForColumn(key);
      const justifyClass = align === 'end' ? 'justify-end text-right' : 'justify-start text-left';

      return (
        <div
          key={key}
          role="columnheader"
          aria-sort={isSortableColumn(key) ? ariaSort(key) : undefined}
          className={cn(headerClass, 'group relative', justifyClass)}
        >
          {isSortableColumn(key) ? (
            <button
              type="button"
              onClick={() => onSort(key)}
              className={cn(
                'flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                justifyClass
              )}
            >
              <span className="truncate">{label}</span>
              {renderSortIcon(key)}
            </button>
          ) : (
            <span className="truncate">{label}</span>
          )}

          <div
            role="separator"
            aria-label={`Resize ${label}`}
            aria-orientation="vertical"
            onPointerDown={e => startResize(key, e)}
            onDoubleClick={e => {
              e.preventDefault();
              e.stopPropagation();
              onClearColumnWidth(key);
            }}
            className={cn(
              'absolute right-0 top-0 flex h-full w-2 touch-none select-none items-center justify-center',
              'cursor-col-resize'
            )}
          >
            <div className="h-[60%] w-px bg-border opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
      );
    };

    return (
      <div ref={ref} className="sticky top-0 z-10 overflow-x-hidden border-b border-border bg-card/80 backdrop-blur">
        <div role="row" style={{ gridTemplateColumns: gridTemplate }} className="grid items-stretch">
          {columns.map(key => renderColumnHeader(key))}
          <div aria-hidden="true" />
        </div>
      </div>
    );
  }
);

LogsHeader.displayName = 'LogsHeader';
