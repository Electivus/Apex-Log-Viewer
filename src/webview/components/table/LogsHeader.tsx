import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../utils/cn';

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
    const baseClass =
      'flex items-center gap-1 px-2 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground';
    const sortArrow = (key: SortKey) => {
      if (sortBy !== key) {
        return null;
      }
      return sortDir === 'asc' ? (
        <ChevronUp className="h-3 w-3" aria-hidden />
      ) : (
        <ChevronDown className="h-3 w-3" aria-hidden />
      );
    };

    return (
      <div
        ref={ref}
        role="row"
        style={{ gridTemplateColumns: gridTemplate }}
        className="sticky top-0 z-10 grid items-center border-b border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div
          role="columnheader"
          aria-sort={sortBy === 'user' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('user')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.user}
          {sortArrow('user')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'application' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('application')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.application}
          {sortArrow('application')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'operation' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('operation')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.operation}
          {sortArrow('operation')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'time' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('time')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.time}
          {sortArrow('time')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'duration' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('duration')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.duration}
          {sortArrow('duration')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'status' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('status')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.status}
          {sortArrow('status')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'codeUnit' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('codeUnit')}
          className={cn(baseClass, 'cursor-pointer')}
        >
          {t.columns.codeUnitStarted}
          {sortArrow('codeUnit')}
        </div>
        <div
          role="columnheader"
          aria-sort={sortBy === 'size' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('size')}
          className={cn(baseClass, 'cursor-pointer justify-end pr-3 text-right')}
        >
          {t.columns.size}
          {sortArrow('size')}
        </div>
        <div aria-hidden className="px-2" />
      </div>
    );
  }
);
