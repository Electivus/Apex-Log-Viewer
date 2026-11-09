import React from 'react';
import type { CustomLogColumn, CustomLogHeaderRow, CustomLogRow } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { countLabel, formatLogTime } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { DetailCloseButton, DetailPane, Fact, Facts } from './DetailPane';
import { LevelBadge } from './LevelBadge';
import { PayloadSection } from './PayloadSection';

type CustomLogRowDetailProps = {
  t: CustomLogsMessages;
  row: CustomLogRow;
  /** The header's display columns, as the page names them. */
  logColumns: readonly CustomLogColumn[];
  dock: 'right' | 'bottom';
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onClose: () => void;
  onOpenLog: (row: CustomLogRow) => void;
  onOpenPayload: (row: CustomLogRow) => void;
  onToggleColumn: (path: string) => void;
};

function countsText(t: CustomLogsMessages, counts: CustomLogHeaderRow['counts']): string | undefined {
  if (!counts) {
    return undefined;
  }
  const parts = [
    counts.entries === undefined ? '' : countLabel(counts.entries, t.viewer.entriesCountOne, t.viewer.entriesCount),
    counts.errors ? countLabel(counts.errors, t.viewer.errorsCountOne, t.viewer.errorsCount) : '',
    counts.warnings ? countLabel(counts.warnings, t.viewer.warningsCountOne, t.viewer.warningsCount) : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The transaction an entry row belongs to: its name, start, worst level, counts and mapped columns. */
function LogFacts({
  t,
  log,
  columns
}: {
  t: CustomLogsMessages;
  log: CustomLogHeaderRow;
  columns: readonly CustomLogColumn[];
}) {
  return (
    <section aria-label={t.detail.log} className="flex flex-col gap-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <b>{t.detail.log}</b>
        <span className="truncate font-mono" title={log.title ?? log.id}>
          {log.title ?? log.id}
        </span>
      </div>
      <Facts>
        <Fact label={t.detail.logStart} value={formatLogTime(log.time)} />
        <Fact label={t.detail.logLevel} value={log.level} />
        <Fact label={t.detail.logEntries} value={countsText(t, log.counts)} />
        {columns.map(column => {
          const value = log.extra[column.key];
          return (
            <Fact
              key={column.key}
              label={column.label}
              value={value === null || value === undefined ? undefined : String(value)}
            />
          );
        })}
      </Facts>
    </section>
  );
}

/** The selected row: who and when, the log it belongs to, then its payload as a key/value tree with column actions. */
export function CustomLogRowDetail({
  t,
  row,
  logColumns,
  dock,
  columns,
  lockedColumns,
  onClose,
  onOpenLog,
  onOpenPayload,
  onToggleColumn
}: CustomLogRowDetailProps) {
  return (
    <DetailPane
      ariaLabel={t.detail.title}
      testId="custom-log-row-detail"
      dock={dock}
      size={{ right: 'w-[400px]', bottom: 'h-[300px]' }}
      header={
        <>
          <LevelBadge level={row.level} />
          <b className="min-w-0 truncate" title={row.title}>
            {row.title ?? row.id}
          </b>
          <span className="flex-1" />
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenLog(row)}>
            {t.detail.openLog}
          </Button>
          <DetailCloseButton label={t.detail.close} onClick={onClose} />
        </>
      }
    >
      <Facts>
        <Fact label={t.detail.time} value={formatLogTime(row.time)} />
        <Fact label={t.detail.origin} value={row.origin} />
        <Fact label={t.detail.user} value={row.user} />
        <Fact label={t.detail.transactionId} value={row.transactionId} />
        <Fact label={t.detail.requestId} value={row.requestId} />
      </Facts>
      {row.log ? <LogFacts t={t} log={row.log} columns={logColumns} /> : null}
      {row.payload ? (
        <PayloadSection
          t={t}
          payload={row.payload}
          columns={columns}
          lockedColumns={lockedColumns}
          canOpenFull
          onOpenFull={() => onOpenPayload(row)}
          onToggleColumn={onToggleColumn}
        />
      ) : null}
    </DetailPane>
  );
}
