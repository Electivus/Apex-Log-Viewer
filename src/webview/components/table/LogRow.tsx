import React, { useLayoutEffect, useRef } from 'react';
import { BugPlay, FileText, Loader2 } from 'lucide-react';
import type { ApexLogRow } from '../../../shared/types';
import type { LogHeadMap } from '../LogsTable';
import { formatBytes, formatDuration } from '../../utils/format';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

type Props = {
  r: ApexLogRow;
  logHead: LogHeadMap;
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
  }, [index, setRowHeight, logHead[r.Id]?.codeUnitStarted, r]);

  const cellClass =
    'min-w-0 px-3 py-2 text-sm leading-relaxed text-foreground/90 transition-colors break-words';

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
        <div className={cellClass}>{r.LogUser?.Name ?? ''}</div>
        <div className={cellClass}>{r.Application}</div>
        <div className={cellClass}>{r.Operation}</div>
        <div className={cellClass}>{new Date(r.StartTime).toLocaleString(locale)}</div>
        <div className={cellClass}>{formatDuration(r.DurationMilliseconds)}</div>
        <div className={cellClass}>{r.Status}</div>
        <div className={cellClass} title={logHead[r.Id]?.codeUnitStarted ?? ''}>
          {logHead[r.Id]?.codeUnitStarted ?? ''}
        </div>
        <div className={cn(cellClass, 'text-right font-medium tabular-nums text-foreground')}>
          {formatBytes(r.LogLength)}
        </div>
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
