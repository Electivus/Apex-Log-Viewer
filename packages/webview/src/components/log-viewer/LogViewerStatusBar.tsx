import React from 'react';
import { formatBytes } from '../../utils/format';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import { fillTemplate } from '../../utils/customLogs/format';

interface Props {
  counts: {
    total: number;
    debug: number;
    errors: number;
    soql: number;
    dml: number;
  };
  locale: string;
  metadata?: {
    sizeBytes?: number;
    modifiedAt?: string;
  };
  /** `loading` while the log content is on its way, `failed` when it could not be read. */
  state?: 'loading' | 'failed' | 'ready';
  t?: LogViewerMessages;
}

function formatNumber(n: number, locale: string) {
  try {
    return n.toLocaleString(locale || undefined);
  } catch {
    return n.toLocaleString();
  }
}

export function LogViewerStatusBar({ counts, locale, metadata, state = 'ready', t = logViewerEn }: Props) {
  const modified = metadata?.modifiedAt ? new Date(metadata.modifiedAt) : undefined;
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-card/40 px-5 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-4">
        <span>{fillTemplate(t.status.totalLines, { count: formatNumber(counts.total, locale) })}</span>
        <span>{fillTemplate(t.status.debugStatements, { count: formatNumber(counts.debug, locale) })}</span>
        <span>{fillTemplate(t.status.errorEvents, { count: formatNumber(counts.errors, locale) })}</span>
        <span>{fillTemplate(t.status.soqlQueries, { count: formatNumber(counts.soql, locale) })}</span>
        <span>{fillTemplate(t.status.dmlOperations, { count: formatNumber(counts.dml, locale) })}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        {typeof metadata?.sizeBytes === 'number' && (
          <span>{fillTemplate(t.status.size, { size: formatBytes(metadata.sizeBytes) })}</span>
        )}
        {modified && !Number.isNaN(modified.getTime()) && (
          <span>{fillTemplate(t.status.updated, { date: modified.toLocaleString(locale || undefined) })}</span>
        )}
        <span>{t.status[state]}</span>
      </div>
    </footer>
  );
}
