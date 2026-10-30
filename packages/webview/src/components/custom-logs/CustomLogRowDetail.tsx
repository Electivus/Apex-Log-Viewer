import React from 'react';
import type { CustomLogRow, CustomLogScalar } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { formatLogTime } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { DetailCloseButton, DetailPane, Fact, Facts } from './DetailPane';
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
        <Fact label={t.detail.user} value={row.user} />
        <Fact label={t.detail.transactionId} value={row.transactionId} />
        <Fact label={t.detail.requestId} value={row.requestId} />
      </Facts>
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
    </DetailPane>
  );
}
