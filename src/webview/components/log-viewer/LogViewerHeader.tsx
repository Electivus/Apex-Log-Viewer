import React from 'react';
import { ChevronDown, ChevronUp, FileText, Search } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';

interface Props {
  fileName: string;
  search: string;
  onSearchChange: (value: string) => void;
  onViewRaw: () => void;
  disabled?: boolean;
  matchCount?: number;
  activeMatchIndex?: number;
  onNextMatch?: () => void;
  onPreviousMatch?: () => void;
}

export function LogViewerHeader({
  fileName,
  search,
  onSearchChange,
  onViewRaw,
  disabled,
  matchCount = 0,
  activeMatchIndex,
  onNextMatch,
  onPreviousMatch
}: Props) {
  const hasQuery = search.trim().length > 0;
  const totalMatches = matchCount;
  const currentMatch = activeMatchIndex !== undefined && activeMatchIndex !== null && activeMatchIndex >= 0 ? activeMatchIndex + 1 : 0;
  const matchLabel = hasQuery ? `${currentMatch}/${totalMatches}` : '';

  return (
    <header className="flex items-center justify-between gap-4 border-b border-border/60 bg-card/40 px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="h-5 w-5 text-sky-400" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">Apex Log Viewer</div>
          <div className="truncate text-xs text-muted-foreground">{fileName || 'Debug Log Analysis'}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
              placeholder="Search entries…"
              className={cn('w-64 pl-8 text-sm', disabled && 'opacity-70')}
              disabled={disabled}
              type="search"
            />
          </div>
          {hasQuery && (
            <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1.5 py-1 text-[11px] text-muted-foreground">
              <span className="min-w-[42px] text-center tabular-nums">{matchLabel || '0/0'}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onPreviousMatch?.()}
                  disabled={disabled || totalMatches === 0}
                  className="h-6 w-6"
                  aria-label="Previous match"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onNextMatch?.()}
                  disabled={disabled || totalMatches === 0}
                  className="h-6 w-6"
                  aria-label="Next match"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onViewRaw} disabled={disabled} className="text-sm">
          <FileText className="mr-2 h-4 w-4" />
          View Raw
        </Button>
      </div>
    </header>
  );
}
