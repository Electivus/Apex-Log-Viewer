import React from 'react';
import { formatBytes } from '../../utils/format';

interface Props {
  counts: {
    total: number;
    debug: number;
    soql: number;
    dml: number;
  };
  locale: string;
  metadata?: {
    sizeBytes?: number;
    modifiedAt?: string;
  };
}

function formatNumber(n: number, locale: string) {
  try {
    return n.toLocaleString(locale || undefined);
  } catch {
    return n.toLocaleString();
  }
}

export function LogViewerStatusBar({ counts, locale, metadata }: Props) {
  const modified = metadata?.modifiedAt ? new Date(metadata.modifiedAt) : undefined;
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-card/40 px-5 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-4">
        <span>Total Lines: {formatNumber(counts.total, locale)}</span>
        <span>Debug Statements: {formatNumber(counts.debug, locale)}</span>
        <span>SOQL Queries: {formatNumber(counts.soql, locale)}</span>
        <span>DML Operations: {formatNumber(counts.dml, locale)}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        {typeof metadata?.sizeBytes === 'number' && (
          <span>Size: {formatBytes(metadata.sizeBytes)}</span>
        )}
        {modified && !Number.isNaN(modified.getTime()) && (
          <span>Updated: {modified.toLocaleString(locale || undefined)}</span>
        )}
        <span>Ready</span>
      </div>
    </footer>
  );
}
