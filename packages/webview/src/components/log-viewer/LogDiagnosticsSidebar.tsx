import React from 'react';
import { AlertCircle, ScanSearch } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import type { LogViewerMappedDiagnostic } from '../../utils/logViewerDiagnostics';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import { fillTemplate } from '../../utils/customLogs/format';
import { SEVERITY_VISUALS } from './logVisuals';

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
  t?: LogViewerMessages;
}

const NOTICE = 'flex h-24 items-center justify-center px-3 text-center text-sm text-muted-foreground';

export function LogDiagnosticsSidebar({
  diagnostics,
  activeId,
  filter,
  onFilterChange,
  onSelectDiagnostic,
  primaryReason,
  triageState,
  t: messages = logViewerEn
}: Props) {
  const t = messages.diagnostics;
  const visibleDiagnostics = diagnostics.filter(diagnostic => {
    if (filter === 'all') {
      return true;
    }
    return diagnostic.severity === filter;
  });
  const summaryText = primaryReason?.trim() ? primaryReason : undefined;
  const tabs: ReadonlyArray<{ filter: SeverityFilter; label: string }> = [
    { filter: 'all', label: t.all },
    { filter: 'error', label: t.errors },
    { filter: 'warning', label: t.warnings }
  ];

  return (
    <aside className="flex max-h-56 min-h-0 flex-col border-l border-border lg:max-h-none">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
          <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t.title}</span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {fillTemplate(t.total, { count: diagnostics.length })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1">
        {tabs.map(tab => (
          <Button
            key={tab.filter}
            type="button"
            size="sm"
            variant={filter === tab.filter ? 'default' : 'ghost'}
            aria-pressed={filter === tab.filter}
            className="log-toggle"
            onClick={() => onFilterChange(tab.filter)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {triageState === 'loading' ? (
        <div className={NOTICE}>{t.loading}</div>
      ) : triageState === 'unavailable' ? (
        <div className={NOTICE}>{t.unavailable}</div>
      ) : triageState === 'empty' ? (
        <div className={NOTICE}>{t.none}</div>
      ) : diagnostics.length === 0 && summaryText ? (
        <div className="space-y-2 px-3 py-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t.summary}</span>
          </div>
          <div className="text-sm text-foreground">{summaryText}</div>
        </div>
      ) : visibleDiagnostics.length === 0 ? (
        <div className={NOTICE}>{t.none}</div>
      ) : (
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1 text-sm">
          {visibleDiagnostics.map(diagnostic => {
            const isActive = diagnostic.originalIndex === activeId;
            const { className: severityClass, icon: SeverityIcon } = SEVERITY_VISUALS[diagnostic.severity];
            const displayLineNumber = diagnostic.mappedLineNumber ?? diagnostic.line;
            const message = diagnostic.mappedMessage ?? diagnostic.summary;
            const secondaryText = isActive ? 'text-foreground' : 'text-muted-foreground';
            return (
              <li key={diagnostic.originalIndex}>
                <button
                  type="button"
                  onClick={() => onSelectDiagnostic(diagnostic.originalIndex)}
                  className={cn(
                    'block w-full rounded-sm px-2 py-1.5 text-left text-foreground transition-colors',
                    isActive ? 'log-selected' : 'hover:bg-muted/60'
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <SeverityIcon
                      className={cn('log-sev-icon h-3.5 w-3.5 shrink-0', severityClass)}
                      role="img"
                      aria-label={t.severity[diagnostic.severity]}
                    />
                    <span className={cn('text-[11px] uppercase tracking-wide', secondaryText)}>
                      {diagnostic.code.replace(/_/g, ' ')}
                    </span>
                    <span className={cn('ml-auto shrink-0 text-xs', secondaryText)}>
                      {displayLineNumber !== undefined ? fillTemplate(t.line, { line: displayLineNumber }) : t.unmapped}
                    </span>
                  </div>
                  <div title={message} className="mt-0.5 line-clamp-3 break-words">
                    {message}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
