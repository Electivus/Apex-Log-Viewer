import React from 'react';
import { formatBytes } from '../../utils/format';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import { fillTemplate } from '../../utils/customLogs/format';

interface Props {
  totalLines: number;
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

export function LogViewerStatusBar({ totalLines, locale, metadata, state = 'ready', t = logViewerEn }: Props) {
  const modified = metadata?.modifiedAt ? new Date(metadata.modifiedAt) : undefined;
  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
      <span>{fillTemplate(t.status.totalLines, { count: formatNumber(totalLines, locale) })}</span>
      <div className="flex items-center gap-3">
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
