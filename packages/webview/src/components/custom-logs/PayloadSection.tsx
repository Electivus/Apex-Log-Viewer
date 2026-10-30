import React from 'react';
import { FileJson, TriangleAlert } from 'lucide-react';
import type { CustomLogPayloadView, CustomLogScalar } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { PayloadTree } from './PayloadTree';

type PayloadSectionProps = {
  t: CustomLogsMessages;
  payload: CustomLogPayloadView;
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  /** Whether the host can show the whole payload for this record. */
  canOpenFull: boolean;
  onOpenFull: () => void;
  onToggleColumn: (path: string) => void;
  onFilterEqual: (path: string, value: CustomLogScalar) => void;
};

const NOTE_KEY = {
  invalid: 'invalidNote',
  text: 'textNote',
  empty: 'emptyNote',
  hidden: 'hiddenNote'
} as const;

/** One payload as the detail panes show it: the key/value tree when it parsed, otherwise why it did not. */
export function PayloadSection({
  t,
  payload,
  columns,
  lockedColumns,
  canOpenFull,
  onOpenFull,
  onToggleColumn,
  onFilterEqual
}: PayloadSectionProps) {
  const openable = canOpenFull && payload.state !== 'empty' && payload.state !== 'hidden';
  return (
    <section aria-label={t.payload.title} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <FileJson className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <b>{t.payload.title}</b>
        <span
          className={
            payload.state === 'parsed'
              ? 'rounded-full border border-sky-500/50 px-1.5 text-[10px] leading-[15px] text-sky-400'
              : 'rounded-full border border-amber-500/50 px-1.5 text-[10px] leading-[15px] text-amber-400'
          }
        >
          {payload.state === 'parsed' ? 'JSON' : t.payload[payload.state]}
        </span>
        <span className="flex-1" />
        {openable ? (
          <Button type="button" variant="outline" size="sm" onClick={onOpenFull}>
            {t.payload.openFull}
          </Button>
        ) : null}
      </div>
      {payload.state === 'parsed' ? (
        <>
          {payload.droppedPaths > 0 ? (
            <p className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {fillTemplate(t.payload.droppedPaths, { count: payload.droppedPaths })}
            </p>
          ) : null}
          <PayloadTree
            t={t.payload}
            values={payload.values}
            columns={columns}
            lockedColumns={lockedColumns}
            cutValues={payload.cutValues}
            onToggleColumn={onToggleColumn}
            onFilterEqual={onFilterEqual}
          />
        </>
      ) : (
        <p
          className={
            payload.state === 'empty'
              ? 'rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground'
              : 'flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300'
          }
        >
          {payload.state === 'empty' ? null : <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          {t.payload[NOTE_KEY[payload.state]]}
        </p>
      )}
    </section>
  );
}
