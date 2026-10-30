import React from 'react';
import { Copy, FileText, Info, Loader2, Lock, RefreshCw } from 'lucide-react';
import type {
  CustomLogApexLogLink,
  CustomLogLongFieldView,
  CustomLogRow,
  CustomLogSourceRef
} from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate, formatLogTime } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { LevelBadge } from './LevelBadge';

type CustomLogViewerHeaderProps = {
  t: CustomLogsMessages;
  source?: CustomLogSourceRef;
  log?: CustomLogRow;
  logPayload?: CustomLogLongFieldView;
  apexLog: CustomLogApexLogLink | undefined;
  loading: boolean;
  onRefresh: () => void;
  onOpenApexLog: () => void;
  onOpenLogPayload: () => void;
  onCopy: (text: string) => void;
};

function Id({
  label,
  value,
  copyLabel,
  onCopy
}: {
  label: string;
  value?: string;
  copyLabel: string;
  onCopy: (text: string) => void;
}) {
  if (!value) {
    return null;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[120px] truncate font-mono" title={value}>
        {value}
      </span>
      <button
        type="button"
        aria-label={`${copyLabel} ${label}`}
        title={`${copyLabel} ${label}`}
        className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-foreground/15 hover:text-foreground"
        onClick={() => onCopy(value)}
      >
        <Copy className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

function countLabel(count: number, one: string, many: string): string {
  return count === 1 ? one : fillTemplate(many, { count });
}

const APEX_LOG_HINTS: Record<Exclude<CustomLogApexLogLink['state'], 'linked'>, (t: CustomLogsMessages) => string> = {
  notFound: t => t.viewer.apexNotFound,
  unavailable: t => t.viewer.apexUnavailable,
  noRequestId: t => t.viewer.apexNoRequestId
};

export function CustomLogViewerHeader({
  t,
  source,
  log,
  logPayload,
  apexLog,
  loading,
  onRefresh,
  onOpenApexLog,
  onOpenLogPayload,
  onCopy
}: CustomLogViewerHeaderProps) {
  const counts = log?.counts;
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card/40 px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" data-testid="custom-log-viewer-title">
            {log?.title ?? log?.id ?? t.viewer.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[source?.label, log?.user, log ? formatLogTime(log.time) : undefined].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      {log?.level ? <LevelBadge level={log.level} /> : null}
      {counts ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {counts.entries !== undefined ? (
            <span>{countLabel(counts.entries, t.viewer.entriesCountOne, t.viewer.entriesCount)}</span>
          ) : null}
          {counts.errors ? (
            <span className="text-[color:var(--vscode-charts-red,#f14c4c)]">
              {countLabel(counts.errors, t.viewer.errorsCountOne, t.viewer.errorsCount)}
            </span>
          ) : null}
          {counts.warnings ? (
            <span className="text-[color:var(--vscode-charts-yellow,#cca700)]">
              {countLabel(counts.warnings, t.viewer.warningsCountOne, t.viewer.warningsCount)}
            </span>
          ) : null}
        </span>
      ) : null}
      <Id label={t.detail.transactionId} value={log?.transactionId} copyLabel={t.viewer.entry.copy} onCopy={onCopy} />
      <Id label={t.detail.requestId} value={log?.requestId} copyLabel={t.viewer.entry.copy} onCopy={onCopy} />
      <div className="ml-auto flex items-center gap-3">
        {logPayload && logPayload.state !== 'unmapped' ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{t.viewer.headerPayload}</span>
            {logPayload.state === 'value' ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenLogPayload}>
                {t.viewer.entry.open}
                {logPayload.format === 'json' ? ' JSON' : ''}
              </Button>
            ) : logPayload.state === 'hidden' ? (
              <span className="inline-flex items-center gap-1 text-amber-400">
                <Lock className="h-3 w-3" aria-hidden="true" />
                {t.viewer.entry.stateHidden}
              </span>
            ) : (
              <span className="text-muted-foreground">{t.viewer.entry.stateEmpty}</span>
            )}
          </span>
        ) : null}
        {apexLog?.state === 'linked' ? (
          <Button type="button" variant="secondary" size="sm" title={t.viewer.apexLinked} onClick={onOpenApexLog}>
            {t.viewer.openApexLog}
          </Button>
        ) : apexLog ? (
          <span
            className="flex max-w-[360px] items-center gap-1 text-xs text-muted-foreground"
            data-testid="custom-log-apex-hint"
          >
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {APEX_LOG_HINTS[apexLog.state](t)}
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex items-center gap-1.5"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t.viewer.refresh}
        </Button>
      </div>
    </header>
  );
}
