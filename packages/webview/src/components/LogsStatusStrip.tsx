import React from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

type Props = {
  t: any;
  loading: boolean;
  error?: string;
  warning?: string;
  searchLoading: boolean;
  searchMessage?: string;
  scanMessage?: string;
};

function Notice({
  icon,
  children,
  className
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 break-words', className)}>
      {icon}
      {children}
    </span>
  );
}

const spinner = <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />;
const alertIcon = <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />;

/** Everything the panel has to say besides the rows, in one thin line that exists only while there is something to say. */
export function LogsStatusStrip({ t, loading, error, warning, searchLoading, searchMessage, scanMessage }: Props) {
  const errorLabel = t?.tail?.errorLabel ?? t?.errors?.generic ?? 'Error';
  const warningLabel = t?.warningLabel ?? 'Warning';
  const showLoading = loading && !error && !warning;
  const showSearch = searchLoading || Boolean(searchMessage);
  if (!error && !warning && !showLoading && !showSearch && !scanMessage) {
    return null;
  }
  return (
    <div
      data-testid="logs-status-strip"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-0.5 border-b px-3 py-1 text-xs text-muted-foreground',
        error ? 'border-destructive/40 bg-destructive/10' : 'border-border'
      )}
    >
      {error && (
        <Notice icon={alertIcon} className="text-destructive">
          <span role="alert" className="min-w-0">
            <span className="font-semibold">{errorLabel}:</span> {error}
          </span>
        </Notice>
      )}
      {!error && warning && (
        <Notice
          icon={alertIcon}
          className="text-[color:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow))]"
        >
          <span role="status" className="min-w-0">
            <span className="font-semibold">{warningLabel}:</span> {warning}
          </span>
        </Notice>
      )}
      {showLoading && <Notice icon={spinner}>{t.loading}</Notice>}
      {showSearch && <Notice icon={searchLoading ? spinner : alertIcon}>{searchMessage ?? t.loading}</Notice>}
      {scanMessage && <Notice icon={spinner}>{scanMessage}</Notice>}
    </div>
  );
}
