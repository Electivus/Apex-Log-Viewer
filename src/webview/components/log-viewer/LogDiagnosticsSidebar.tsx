import React from 'react';
import { AlertCircle, AlertTriangle, Filter, ScanSearch } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { LogViewerMappedDiagnostic } from '../../utils/logViewerDiagnostics';

type SeverityFilter = 'all' | 'error' | 'warning';
type TriageState = 'loading' | 'unavailable' | 'empty' | 'ready';

interface Props {
  diagnostics: readonly LogViewerMappedDiagnostic[];
  activeId?: number;
  filter: SeverityFilter;
  onFilterChange: (filter: SeverityFilter) => void;
  onSelectDiagnostic: (id: number) => void;
  primaryReason?: string;
  triageState: TriageState;
}

export function LogDiagnosticsSidebar({
  diagnostics,
  activeId,
  filter,
  onFilterChange,
  onSelectDiagnostic,
  primaryReason,
  triageState
}: Props) {
  const visibleDiagnostics = diagnostics.filter(diagnostic => {
    if (filter === 'all') {
      return true;
    }
    return diagnostic.severity === filter;
  });
  const summaryText = primaryReason?.trim() ? primaryReason : undefined;

  return (
    <aside className="flex h-full w-80 flex-col gap-2 border-l border-border/60 bg-muted/20 px-4 py-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <ScanSearch className="h-3.5 w-3.5" />
          <span>Diagnostics</span>
        </div>
        <span className="text-[11px] text-muted-foreground">{diagnostics.length} total</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant={filter === 'all' ? 'default' : 'ghost'}
          onClick={() => onFilterChange('all')}
          className={cn('h-7 px-2 text-[11px]', filter === 'all' ? 'bg-slate-600 text-white' : 'text-muted-foreground')}
        >
          All
        </Button>
        <Button
          size="sm"
          variant={filter === 'error' ? 'default' : 'ghost'}
          onClick={() => onFilterChange('error')}
          className={cn('h-7 px-2 text-[11px]', filter === 'error' ? 'bg-rose-600 text-white' : 'text-muted-foreground')}
        >
          Errors
        </Button>
        <Button
          size="sm"
          variant={filter === 'warning' ? 'default' : 'ghost'}
          onClick={() => onFilterChange('warning')}
          className={cn('h-7 px-2 text-[11px]', filter === 'warning' ? 'bg-amber-600 text-white' : 'text-muted-foreground')}
        >
          Warnings
        </Button>
      </div>
      <div className="rounded-md border border-border/60 bg-background/80">
        {triageState === 'loading' ? (
          <div className="flex h-32 items-center justify-center p-4 text-sm text-muted-foreground">Loading diagnostics…</div>
        ) : triageState === 'unavailable' ? (
          <div className="flex h-32 items-center justify-center p-4 text-sm text-muted-foreground">Diagnostics unavailable.</div>
        ) : triageState === 'empty' ? (
          <div className="flex h-32 items-center justify-center p-4 text-sm text-muted-foreground">No diagnostics found.</div>
        ) : visibleDiagnostics.length === 0 && summaryText ? (
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>Summary</span>
            </div>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-foreground">{summaryText}</div>
          </div>
        ) : visibleDiagnostics.length === 0 ? (
          <div className="flex h-32 items-center justify-center p-4 text-sm text-muted-foreground">No diagnostics found.</div>
        ) : (
          <ul className="max-h-[calc(100vh-220px)] overflow-y-auto p-2 text-sm">
            {visibleDiagnostics.map(diagnostic => {
              const isActive = diagnostic.originalIndex === activeId;
              const isError = diagnostic.severity === 'error';
              const canJumpToLine = diagnostic.mappedLineNumber !== undefined;
              return (
                <li key={diagnostic.originalIndex}>
                  <button
                    type="button"
                    onClick={() => onSelectDiagnostic(diagnostic.originalIndex)}
                    className={cn(
                      'mb-2 block w-full rounded-md border border-transparent p-2 text-left transition-colors',
                      isActive
                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-100'
                        : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      {isError ? <AlertCircle className="h-3.5 w-3.5 text-red-300" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{diagnostic.code.replace(/_/g, ' ')}</span>
                      <span className="ml-auto flex items-center gap-1">
                        <Filter className="h-3 w-3 text-muted-foreground" />
                        <Badge variant="outline" className={cn('text-[10px]', isError ? 'border-red-500/40 text-red-200' : 'border-amber-500/40 text-amber-200')}>
                          {diagnostic.severity}
                        </Badge>
                      </span>
                    </div>
                    <div className="break-words text-foreground">{diagnostic.summary}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {canJumpToLine ? `Line ${diagnostic.mappedLineNumber}` : 'Unmapped'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
