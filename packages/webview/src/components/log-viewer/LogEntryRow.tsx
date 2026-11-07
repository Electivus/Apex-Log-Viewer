import React from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { ParsedLogEntry } from '../../utils/logViewerParser';
import type { LogViewerMappedDiagnostic } from '../../utils/logViewerDiagnostics';
import { CATEGORY_VISUALS, SEVERITY_VISUALS } from './logVisuals';

/** Fixed tracks keep the message column at one position for every row, whatever the badge says. */
const ROW_COLUMNS = 'grid-cols-[5.5rem_10.5rem_3rem_minmax(0,1fr)]';

interface Props {
  entry: ParsedLogEntry;
  highlighted: boolean;
  isActiveDiagnostic?: boolean;
  isMatch?: boolean;
  isActiveMatch?: boolean;
  diagnostics?: readonly LogViewerMappedDiagnostic[];
  activeDiagnosticId?: number;
  searchTerm?: string;
}

export function LogEntryRow({
  entry,
  highlighted,
  isActiveDiagnostic,
  isMatch,
  isActiveMatch,
  diagnostics,
  activeDiagnosticId,
  searchTerm
}: Props) {
  const { className: categoryClass, icon: Icon } = CATEGORY_VISUALS[entry.category];
  const normalizedTerm = (searchTerm ?? '').trim();
  const showMatchHighlight = normalizedTerm.length > 0 && isMatch;
  const rowDiagnostics = diagnostics ?? [];
  const hasActiveDiagnostic = typeof activeDiagnosticId === 'number';

  return (
    <div
      className={cn(
        'log-row grid items-start gap-x-3 px-3 py-1 text-xs',
        ROW_COLUMNS,
        highlighted && 'log-row-highlighted',
        showMatchHighlight && 'log-row-match',
        isActiveMatch && 'log-row-active-match',
        isActiveDiagnostic && 'log-selected'
      )}
    >
      <div className="font-mono text-[11px] leading-5 text-muted-foreground">{entry.timestamp || '—'}</div>
      <span
        title={entry.type}
        className={cn(
          'log-cat-badge inline-flex min-w-0 max-w-full items-center gap-1 justify-self-start rounded-sm border px-1.5 text-[11px] font-medium leading-5',
          categoryClass
        )}
      >
        <Icon className="log-cat-icon h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{entry.type}</span>
      </span>
      <div className="font-mono text-[11px] leading-5 text-muted-foreground">
        {entry.lineNumber ? `[${entry.lineNumber}]` : ''}
      </div>
      <div className="min-w-0 space-y-1 leading-5 text-foreground">
        <div className="whitespace-pre-wrap break-words">{highlightText(entry.message, normalizedTerm)}</div>
        {entry.details && (
          <div className="whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {highlightText(entry.details, normalizedTerm)}
          </div>
        )}
        {rowDiagnostics.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="list">
            {rowDiagnostics.map(diagnostic => {
              const isActive = hasActiveDiagnostic && diagnostic.originalIndex === activeDiagnosticId;
              const { className: severityClass, icon: SeverityIcon } = SEVERITY_VISUALS[diagnostic.severity];
              return (
                <Badge
                  key={diagnostic.originalIndex}
                  role="listitem"
                  variant="outline"
                  className={cn(
                    'gap-1 rounded-sm px-1.5 py-0 text-[11px] leading-5',
                    severityClass,
                    isActive ? 'border-ring bg-muted' : 'bg-muted/40'
                  )}
                >
                  <SeverityIcon className="log-sev-icon h-3 w-3 shrink-0" aria-hidden="true" />
                  {diagnostic.summary}
                </Badge>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function highlightText(text: string | undefined, term: string) {
  if (!text) {
    return null;
  }
  const trimmed = term.trim();
  if (!trimmed) {
    return text;
  }
  const lower = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  if (!lower.includes(needle)) {
    return text;
  }
  const parts: React.ReactNode[] = [];
  let index = 0;
  let matchIndex = lower.indexOf(needle, index);
  let key = 0;
  while (matchIndex !== -1) {
    if (matchIndex > index) {
      parts.push(text.slice(index, matchIndex));
    }
    const matchText = text.slice(matchIndex, matchIndex + trimmed.length);
    parts.push(
      <mark key={`match-${key++}`} className="log-find-mark">
        {matchText}
      </mark>
    );
    index = matchIndex + trimmed.length;
    matchIndex = lower.indexOf(needle, index);
  }
  if (index < text.length) {
    parts.push(text.slice(index));
  }
  return <>{parts}</>;
}
