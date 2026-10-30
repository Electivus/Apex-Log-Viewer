import React from 'react';
import { X } from 'lucide-react';
import type { CustomLogRow, CustomLogScalar } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { formatLogTime } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { LevelBadge } from './LevelBadge';
import { PayloadSection } from './PayloadSection';

type CustomLogRowDetailProps = {
  t: CustomLogsMessages;
  row: CustomLogRow;
  dock: 'right' | 'bottom';
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onClose: () => void;
  onOpenLog: (row: CustomLogRow) => void;
  onOpenPayload: (row: CustomLogRow) => void;
  onToggleColumn: (path: string) => void;
  onFilterEqual: (path: string, value: CustomLogScalar) => void;
};

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <span className="min-w-0 truncate" title={value}>
      <span className="text-muted-foreground">{label} </span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

/** The selected row: who and when, then its payload as a key/value tree with column and filter actions. */
export function CustomLogRowDetail({
  t,
  row,
  dock,
  columns,
  lockedColumns,
  onClose,
  onOpenLog,
  onOpenPayload,
  onToggleColumn,
  onFilterEqual
}: CustomLogRowDetailProps) {
  return (
    <aside
      aria-label={t.detail.title}
      data-testid="custom-log-row-detail"
      className={cn(
        'flex min-h-0 min-w-0 shrink-0 flex-col bg-card/60',
        dock === 'right' ? 'w-[400px] border-l border-border' : 'h-[300px] border-t border-border'
      )}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <LevelBadge level={row.level} />
        <b className="min-w-0 truncate" title={row.title}>
          {row.title ?? row.id}
        </b>
        <span className="flex-1" />
        <Button type="button" variant="secondary" size="sm" onClick={() => onOpenLog(row)}>
          {t.detail.openLog}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 min-h-0 w-6"
          aria-label={t.detail.close}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-2">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          <Fact label={t.detail.time} value={formatLogTime(row.time)} />
          <Fact label={t.detail.user} value={row.user} />
          <Fact label={t.detail.transactionId} value={row.transactionId} />
          <Fact label={t.detail.requestId} value={row.requestId} />
        </div>
        {row.payload ? (
          <PayloadSection
            t={t}
            payload={row.payload}
            columns={columns}
            lockedColumns={lockedColumns}
            canOpenFull
            onOpenFull={() => onOpenPayload(row)}
            onToggleColumn={onToggleColumn}
            onFilterEqual={onFilterEqual}
          />
        ) : null}
      </div>
    </aside>
  );
}
