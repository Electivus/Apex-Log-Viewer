import React, { useLayoutEffect, useRef } from 'react';
import { ExternalLink, Loader2, Redo2 } from 'lucide-react';
import type { ApexLogRow } from '../../../shared/types';
import type { LogHeadMap } from '../LogsTable';
import { formatBytes, formatDuration } from '../../utils/format';
import { IconButton } from '../IconButton';

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
      // add 1 for the row bottom border to avoid clipping
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only handle keys when the event originates on the row itself.
    // This avoids hijacking keyboard interactions of inner buttons.
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
        className="grid items-center border-b border-border/60 bg-background/60 text-sm"
      >
        <div className="min-w-0 px-2 py-2 break-words">{r.LogUser?.Name ?? ''}</div>
        <div className="min-w-0 px-2 py-2 break-words">{r.Application}</div>
        <div className="min-w-0 px-2 py-2 break-words">{r.Operation}</div>
        <div className="min-w-0 px-2 py-2 break-words text-xs text-muted-foreground">
          {new Date(r.StartTime).toLocaleString(locale)}
        </div>
        <div className="min-w-0 px-2 py-2 break-words">{formatDuration(r.DurationMilliseconds)}</div>
        <div className="min-w-0 px-2 py-2 break-words">{r.Status}</div>
        <div
          className="min-w-0 px-2 py-2 break-words"
          title={logHead[r.Id]?.codeUnitStarted ?? ''}
        >
          {logHead[r.Id]?.codeUnitStarted ?? ''}
        </div>
        <div className="px-2 py-2 text-right font-mono text-xs text-muted-foreground">
          {formatBytes(r.LogLength)}
        </div>
        <div className="px-2 py-2">
          <div className="flex items-center justify-center gap-2">
            <IconButton
              tooltip={t.open ?? 'Open'}
              ariaLabel={t.open ?? 'Open'}
              disabled={loading}
              onClick={e => {
                e.stopPropagation();
                onOpen(r.Id);
              }}
              className="text-primary hover:text-primary"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
            </IconButton>
            <IconButton
              tooltip={t.replay}
              ariaLabel={t.replay}
              disabled={loading}
              onClick={e => {
                e.stopPropagation();
                onReplay(r.Id);
              }}
              className="text-accent-foreground hover:text-primary"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Redo2 className="h-4 w-4" aria-hidden />}
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
