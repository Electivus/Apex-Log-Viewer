import React from 'react';
import { AlertOctagon, BugPlay, FileText } from 'lucide-react';
import type { ApexLogRow } from '@alv/protocol/types';
import type { LogHeadMap } from '../LogsTable';
import type { LogsColumnKey } from '@alv/protocol/logsColumns';
import { formatBytes, formatDuration } from '../../utils/format';
import { focusSnippet, splitOperation, type SnippetRanges } from '../../utils/logsCells';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

type Props = {
  r: ApexLogRow;
  logHead: LogHeadMap;
  matchSnippet?: { text: string; ranges: SnippetRanges };
  columns: LogsColumnKey[];
  locale: string;
  t: any;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  gridTemplate: string;
  minWidthPx: number;
  style: React.CSSProperties;
};

/**
 * The row paints its hover tint as an image over an opaque background, and the pinned actions cell paints the
 * same two layers from the inherited `--row-tint`. Both stay opaque, so a column scrolling under the actions
 * never shows through, and they match in every theme, including those whose hover color is translucent.
 */
const ROW_SURFACE = 'bg-background [background-image:linear-gradient(var(--row-tint),var(--row-tint))]';
const ROW_TINT = '[--row-tint:transparent] hover:[--row-tint:var(--vscode-list-hoverBackground,var(--muted))]';

const CELL = 'min-w-0 truncate px-2';

const BADGE = 'px-1.5 py-0 text-[11px] leading-4';

function Snippet({ snippet }: { snippet?: { text: string; ranges: SnippetRanges } }) {
  if (!snippet || !snippet.text) {
    return <span className="text-muted-foreground/70">—</span>;
  }
  const { text, ranges } = focusSnippet(snippet.text, snippet.ranges);
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  [...ranges]
    .sort((a, b) => a[0] - b[0])
    .forEach(([start, end], idx) => {
      const safeStart = Math.max(cursor, Math.min(start, text.length));
      const safeEnd = Math.max(safeStart, Math.min(end, text.length));
      if (safeStart > cursor) {
        pieces.push(<span key={`pre-${idx}`}>{text.slice(cursor, safeStart)}</span>);
      }
      pieces.push(
        <mark key={`hit-${idx}`} className="match-highlight">
          {text.slice(safeStart, safeEnd)}
        </mark>
      );
      cursor = safeEnd;
    });
  if (cursor < text.length) {
    pieces.push(<span key="post">{text.slice(cursor)}</span>);
  }
  return <>{pieces}</>;
}

export function LogRow({
  r,
  logHead,
  matchSnippet,
  columns,
  locale,
  t,
  onOpen,
  onReplay,
  gridTemplate,
  minWidthPx,
  style
}: Props) {
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

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The second click of a double click, a drag that selected text and a click on an action are not "open".
    if (e.detail > 1) return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    onOpen(r.Id);
  };

  const logHeadEntry = logHead[r.Id];
  const hasErrors = logHeadEntry?.hasErrors === true;
  const primaryReason = hasErrors ? logHeadEntry?.primaryReason?.trim() : '';
  const errorLabel = t?.filters?.errorDetectedBadge ?? 'Error';

  const actionButton = (icon: React.ReactNode, label: string, handler: () => void) => (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-6 min-h-6 w-6 min-w-6 text-foreground/80 hover:bg-[var(--vscode-toolbar-hoverBackground,var(--muted))] hover:text-foreground"
      aria-label={label}
      title={label}
      onClick={handler}
    >
      {icon}
    </Button>
  );

  const renderCell = (key: LogsColumnKey) => {
    switch (key) {
      case 'user': {
        const name = r.LogUser?.Name ?? '';
        return (
          <div key={key} className={CELL} title={name}>
            {name}
          </div>
        );
      }
      case 'application':
        return (
          <div key={key} className={CELL} title={r.Application}>
            {r.Application}
          </div>
        );
      case 'operation': {
        const { head, tail } = splitOperation(r.Operation ?? '');
        return (
          <div key={key} className="flex min-w-0 overflow-hidden px-2" title={r.Operation}>
            <span className="min-w-0 truncate">{head}</span>
            {tail && <span className="max-w-full shrink-0 truncate">{tail}</span>}
          </div>
        );
      }
      case 'time': {
        const time = new Date(r.StartTime).toLocaleString(locale);
        return (
          <div key={key} className={CELL} title={time}>
            {time}
          </div>
        );
      }
      case 'duration':
        return (
          <div key={key} className={CELL}>
            {formatDuration(r.DurationMilliseconds)}
          </div>
        );
      case 'status':
        return (
          <div
            key={key}
            className="flex min-w-0 items-center gap-1.5 overflow-hidden px-2"
            title={[r.Status, primaryReason].filter(Boolean).join(' · ')}
          >
            <span data-testid="logs-status-text" className="min-w-0 truncate">
              {r.Status}
            </span>
            {hasErrors && (
              <Badge
                data-testid="logs-error-badge"
                variant="outline"
                className={cn(
                  BADGE,
                  'shrink-0 gap-1 whitespace-nowrap border-destructive/50 bg-destructive/10 text-destructive'
                )}
                title={errorLabel}
              >
                <AlertOctagon className="h-3 w-3" aria-hidden="true" />
                <span>{errorLabel}</span>
              </Badge>
            )}
            {primaryReason && (
              <Badge
                data-testid="logs-reason-badge"
                variant="secondary"
                className={cn(BADGE, 'min-w-0 max-w-[45%] border-border/70 bg-muted/70 text-muted-foreground')}
                title={primaryReason}
              >
                <span className="truncate">{primaryReason}</span>
              </Badge>
            )}
          </div>
        );
      case 'size':
        return (
          <div key={key} className={cn(CELL, 'text-right tabular-nums')}>
            {formatBytes(r.LogLength)}
          </div>
        );
      case 'match':
        return (
          <div key={key} className={cn(CELL, 'text-muted-foreground')} title={matchSnippet?.text ?? ''}>
            <Snippet snippet={matchSnippet} />
          </div>
        );
    }
  };

  return (
    <div
      role="row"
      data-log-id={r.Id}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{ ...style, display: 'grid', gridTemplateColumns: gridTemplate, minWidth: minWidthPx }}
      className={cn(
        'cursor-pointer items-center border-b border-border/40 text-[13px] text-foreground outline-none',
        'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
        ROW_SURFACE,
        ROW_TINT
      )}
    >
      {columns.map(renderCell)}
      <div
        className={cn(
          'sticky right-0 z-[1] flex items-center justify-center gap-1 self-stretch border-l border-border/40',
          ROW_SURFACE
        )}
      >
        {actionButton(<FileText className="h-4 w-4" aria-hidden="true" />, t.open ?? 'Open', () => onOpen(r.Id))}
        {actionButton(<BugPlay className="h-4 w-4" aria-hidden="true" />, t.replay, () => onReplay(r.Id))}
      </div>
    </div>
  );
}
