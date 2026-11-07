import React from 'react';
import { ChevronDown, ChevronUp, FileText, Search } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import type { LogHeading } from '../../utils/logViewerSummary';

interface Props {
  heading: LogHeading;
  search: string;
  onSearchChange: (value: string) => void;
  onViewRaw: () => void;
  disabled?: boolean;
  matchCount?: number;
  activeMatchIndex?: number;
  onNextMatch?: () => void;
  onPreviousMatch?: () => void;
  t?: LogViewerMessages;
}

export function LogViewerHeader({
  heading,
  search,
  onSearchChange,
  onViewRaw,
  disabled,
  matchCount = 0,
  activeMatchIndex,
  onNextMatch,
  onPreviousMatch,
  t = logViewerEn
}: Props) {
  const hasQuery = search.trim().length > 0;
  const totalMatches = matchCount;
  const currentMatch =
    activeMatchIndex !== undefined && activeMatchIndex !== null && activeMatchIndex >= 0 ? activeMatchIndex + 1 : 0;
  const matchLabel = hasQuery ? `${currentMatch}/${totalMatches}` : '';
  const title = heading.title ?? t.title;
  const details = heading.details.join(' · ');

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
      <div className="flex min-w-0 flex-1 basis-64 items-baseline gap-2">
        <h1 title={title} className="m-0 max-w-[60%] shrink-0 truncate text-[13px] font-semibold text-foreground">
          {title}
        </h1>
        {details && (
          <span title={details} className="min-w-0 truncate text-xs text-muted-foreground">
            {details}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            onKeyDown={event => {
              if (!hasQuery) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) {
                  onPreviousMatch?.();
                } else {
                  onNextMatch?.();
                }
              }
            }}
            placeholder={t.searchPlaceholder}
            className={cn('w-64 pl-8 text-sm', disabled && 'opacity-70')}
            disabled={disabled}
            type="search"
          />
        </div>
        {hasQuery && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="min-w-[42px] text-center tabular-nums">{matchLabel || '0/0'}</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onPreviousMatch?.()}
              disabled={disabled || totalMatches === 0}
              className="h-6 min-h-6 w-6"
              aria-label={t.previousMatch}
              title={t.previousMatch}
            >
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onNextMatch?.()}
              disabled={disabled || totalMatches === 0}
              className="h-6 min-h-6 w-6"
              aria-label={t.nextMatch}
              title={t.nextMatch}
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
        <Button variant="outline" size="sm" onClick={onViewRaw} disabled={disabled}>
          <FileText className="h-4 w-4" aria-hidden="true" />
          {t.viewRaw}
        </Button>
      </div>
    </header>
  );
}
