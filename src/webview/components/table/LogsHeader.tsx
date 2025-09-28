import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';

type SortKey = 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';

type Props = {
  t: any;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  gridTemplate: string;
};

export const LogsHeader = React.forwardRef<HTMLDivElement, Props>(
  ({ t, sortBy, sortDir, onSort, gridTemplate }, ref) => {
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

    const renderHeader = (key: SortKey, label: string, align?: 'start' | 'end') => (
      <div
        role="columnheader"
        aria-sort={ariaSort(key)}
        className={cn(headerClass, align === 'end' ? 'justify-end text-right' : 'justify-start text-left')}
      >
        <button
          type="button"
          onClick={() => onSort(key)}
          className={cn(
            'flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            align === 'end' ? 'justify-end text-right' : 'justify-start text-left'
          )}
        >
          <span className="truncate">{label}</span>
          {renderSortIcon(key)}
        </button>
      </div>
    );

    return (
      <div
        ref={ref}
        role="row"
        style={{ gridTemplateColumns: gridTemplate }}
        className="sticky top-0 z-10 grid items-stretch border-b border-border bg-card/80 backdrop-blur"
      >
        {renderHeader('user', t.columns.user)}
        {renderHeader('application', t.columns.application)}
        {renderHeader('operation', t.columns.operation)}
        {renderHeader('time', t.columns.time)}
        {renderHeader('duration', t.columns.duration)}
        {renderHeader('status', t.columns.status)}
        {renderHeader('codeUnit', t.columns.codeUnitStarted)}
        {renderHeader('size', t.columns.size, 'end')}
        <div className={cn(headerClass, 'justify-start text-left text-muted-foreground')} role="columnheader">
          <span className="truncate">{t.columns.match ?? 'Match'}</span>
        </div>
        <div aria-hidden="true" />
      </div>
    );
  }
);

LogsHeader.displayName = 'LogsHeader';
