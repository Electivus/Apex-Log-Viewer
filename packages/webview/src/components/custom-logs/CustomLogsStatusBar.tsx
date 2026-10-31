import React from 'react';
import { Info, Loader2, TriangleAlert } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from '../../utils/customLogs/format';
import type { PayloadStateCounts } from '../../utils/customLogs/payloadRows';
import { Button } from '../ui/button';

type CustomLogsStatusBarProps = {
  t: CustomLogsMessages;
  /** The count sentence, already worded for rows or entries. */
  scope: string;
  /** Payload (loaded-row) filters are active. */
  filtering: boolean;
  /** Payload columns, filters or sorts are in use, so the loaded-rows caveat applies. */
  payloadInUse: boolean;
  /** The caveat shown while payload columns, filters or sorts are in use. */
  hint?: string;
  payloadStates: PayloadStateCounts;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
};

export function CustomLogsStatusBar({
  t,
  scope,
  filtering,
  payloadInUse,
  hint,
  payloadStates,
  hasMore,
  loading,
  onLoadMore
}: CustomLogsStatusBarProps) {
  const problems = [
    payloadStates.invalid ? fillTemplate(t.status.invalidCount, { count: payloadStates.invalid }) : '',
    payloadStates.text ? fillTemplate(t.status.textCount, { count: payloadStates.text }) : '',
    payloadStates.empty ? fillTemplate(t.status.emptyCount, { count: payloadStates.empty }) : '',
    payloadStates.hidden ? fillTemplate(t.status.hiddenCount, { count: payloadStates.hidden }) : ''
  ].filter(Boolean);

  return (
    <footer
      role="status"
      className="flex h-6 shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap border-t border-border bg-[color-mix(in_srgb,var(--vscode-focusBorder,#007acc)_12%,transparent)] px-3 text-xs"
    >
      <span className="flex items-center gap-1">
        <Info className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        {scope}
      </span>
      {hasMore ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-5 min-h-0 gap-1 px-0 text-xs"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          {t.loadMore}
        </Button>
      ) : null}
      {payloadInUse ? <span className="truncate text-muted-foreground">{hint ?? t.status.hint}</span> : null}
      <span className="flex-1" />
      {problems.length > 0 ? (
        <span className="flex items-center gap-1 text-amber-400">
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {problems.join(' · ')}
          {filtering ? `: ${t.status.skipped}` : ''}
        </span>
      ) : null}
    </footer>
  );
}
