import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { AlertOctagon, BugPlay, FileText, Loader2 } from 'lucide-react';
import type { ApexLogRow } from '../../../shared/types';
import type { LogHeadMap } from '../LogsTable';
import type { LogsColumnKey } from '../../../shared/logsColumns';
import { formatBytes, formatDuration } from '../../utils/format';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

type Props = {
  r: ApexLogRow;
  logHead: LogHeadMap;
  matchSnippet?: { text: string; ranges: [number, number][] };
  columns: LogsColumnKey[];
  locale: string;
  t: any;
  loading: boolean;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  gridTemplate: string;
  style: React.CSSProperties;
  index: number;
  setRowHeight: (index: number, size: number) => void;
};

export function LogRow({
  r,
  logHead,
  matchSnippet,
  columns,
  locale,
  t,
  loading,
  onOpen,
  onReplay,
  gridTemplate,
  style,
  index,
  setRowHeight
}: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      const h = el.scrollHeight || el.getBoundingClientRect().height;
      setRowHeight(index, h + 1);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogRow: failed to disconnect ResizeObserver', e);
      }
    };
  }, [
    index,
    setRowHeight,
    logHead[r.Id]?.codeUnitStarted,
    matchSnippet?.text,
    r,
    columns
  ]);

  const cellClass =
    'min-w-0 px-3 py-2 text-sm leading-relaxed text-foreground/90 transition-colors break-words';

  const renderSnippet = useMemo(() => {
    if (!matchSnippet || !matchSnippet.text) {
      return <span className="text-muted-foreground/70">—</span>;
    }
    const { text, ranges } = matchSnippet;
    if (!ranges?.length) {
      return <span>{text}</span>;
    }
    const pieces: React.ReactNode[] = [];
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    sorted.forEach(([start, end], idx) => {
      const safeStart = Math.max(0, Math.min(start, text.length));
      const safeEnd = Math.max(safeStart, Math.min(end, text.length));
      if (safeStart > cursor) {
        pieces.push(
          <span key={`snippet-pre-${idx}`}>{text.slice(cursor, safeStart)}</span>
        );
      }
      pieces.push(
        <mark key={`snippet-hit-${idx}`} className="match-highlight">
          {text.slice(safeStart, safeEnd)}
        </mark>
      );
      cursor = safeEnd;
    });
    if (cursor < text.length) {
      pieces.push(<span key="snippet-post">{text.slice(cursor)}</span>);
    }
    return pieces;
  }, [matchSnippet]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.currentTarget !== e.target) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey) {
        onReplay(r.Id);
      } else {
        onOpen(r.Id);
      }
    }
  };

  const actionButton = (
    icon: React.ReactNode,
    label: string,
    handler: (e: React.MouseEvent<HTMLButtonElement>) => void
  ) => (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-8 w-8 text-primary hover:bg-primary/10"
      disabled={loading}
      aria-label={label}
      title={label}
      onClick={handler}
    >
      {icon}
    </Button>
  );

  return (
    <div
      role="row"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={style}
      className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div
        ref={contentRef}
        style={{ gridTemplateColumns: gridTemplate }}
        className="grid items-stretch border-b border-border bg-background/40 text-sm transition-colors hover:bg-muted/40"
      >
        {columns.map(key => {
          switch (key) {
            case 'user':
              return (
                <div key={key} className={cellClass}>
                  {r.LogUser?.Name ?? ''}
                </div>
              );
            case 'application':
              return (
                <div key={key} className={cellClass}>
                  {r.Application}
                </div>
              );
            case 'operation':
              return (
                <div key={key} className={cellClass}>
                  {r.Operation}
                </div>
              );
            case 'time':
              return (
                <div key={key} className={cellClass}>
                  {new Date(r.StartTime).toLocaleString(locale)}
                </div>
              );
            case 'duration':
              return (
                <div key={key} className={cellClass}>
                  {formatDuration(r.DurationMilliseconds)}
                </div>
              );
            case 'status':
              {
                const hasErrors = logHead[r.Id]?.hasErrors === true;
                const errorBadge = t?.filters?.errorDetectedBadge ?? 'Error';
                return (
                  <div key={key} className={cn(cellClass, 'flex items-center gap-2')}>
                    <span>{r.Status}</span>
                    {hasErrors && (
                      <Badge
                        data-testid="logs-error-badge"
                        variant="outline"
                        className="gap-1 border-destructive/50 bg-destructive/10 text-destructive"
                        title={errorBadge}
                      >
                        <AlertOctagon className="h-3 w-3" aria-hidden="true" />
                        <span>{errorBadge}</span>
                      </Badge>
                    )}
                  </div>
                );
              }
            case 'codeUnit':
              return (
                <div key={key} className={cellClass} title={logHead[r.Id]?.codeUnitStarted ?? ''}>
                  {logHead[r.Id]?.codeUnitStarted ?? ''}
                </div>
              );
            case 'size':
              return (
                <div key={key} className={cn(cellClass, 'text-right font-medium tabular-nums text-foreground')}>
                  {formatBytes(r.LogLength)}
                </div>
              );
            case 'match':
              return (
                <div key={key} className={cn(cellClass, 'text-muted-foreground/90')} title={matchSnippet?.text ?? ''}>
                  <span className="block max-h-[4.5rem] overflow-hidden whitespace-pre-wrap text-left text-sm leading-relaxed">
                    {renderSnippet}
                  </span>
                </div>
              );
          }
        })}
        <div className={cn(cellClass, 'flex items-center justify-center gap-2 text-center')}>
          <div className="flex items-center gap-2">
            {actionButton(
              loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileText className="h-4 w-4" aria-hidden="true" />
              ),
              t.open ?? 'Open',
              e => {
                e.stopPropagation();
                onOpen(r.Id);
              }
            )}
            {actionButton(
              loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <BugPlay className="h-4 w-4" aria-hidden="true" />
              ),
              t.replay,
              e => {
                e.stopPropagation();
                onReplay(r.Id);
              }
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
