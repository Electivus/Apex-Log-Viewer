import React from 'react';
import { Copy, Loader2, Lock } from 'lucide-react';
import type { CustomLogEntry, CustomLogLongFieldView, CustomLogScalar } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { formatLogTime } from '../../utils/customLogs/format';
import { Button } from '../ui/button';
import { DetailCloseButton, DetailPane, Fact, Facts } from './DetailPane';
import { LevelBadge } from './LevelBadge';
import { PayloadSection } from './PayloadSection';

type CustomLogEntryDetailProps = {
  t: CustomLogsMessages;
  entry: CustomLogEntry;
  dock: 'right' | 'bottom';
  /** The long fields the host listed for this entry; absent until it answers. */
  fields: CustomLogLongFieldView[] | undefined;
  loadingFields: boolean;
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onClose: () => void;
  onCopyMessage: (message: string) => void;
  onOpenField: (key: string) => void;
  onToggleColumn: (path: string) => void;
  onFilterEqual: (path: string, value: CustomLogScalar) => void;
};

function FieldState({ t, field }: { t: CustomLogsMessages; field: CustomLogLongFieldView }) {
  switch (field.state) {
    case 'value':
      return (
        <span className="flex items-center gap-1.5">
          {field.format ? (
            <span className="rounded bg-muted px-1.5 font-mono text-[10px] uppercase text-muted-foreground">
              {field.format}
            </span>
          ) : null}
          {field.truncated ? (
            <span className="text-[11px] text-amber-400">{t.viewer.entry.truncatedByLogger}</span>
          ) : null}
        </span>
      );
    case 'hidden':
      return (
        <span className="flex items-center gap-1 text-[11px] text-amber-400">
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t.viewer.entry.stateHidden}
        </span>
      );
    default:
      return <span className="text-[11px] text-muted-foreground">{t.viewer.entry.stateEmpty}</span>;
  }
}

/** The selected entry: its facts, its long fields with their states, and its JSON payload. */
export function CustomLogEntryDetail({
  t,
  entry,
  dock,
  fields,
  loadingFields,
  columns,
  lockedColumns,
  onClose,
  onCopyMessage,
  onOpenField,
  onToggleColumn,
  onFilterEqual
}: CustomLogEntryDetailProps) {
  const listed = (fields ?? []).filter(
    field => field.state !== 'unmapped' && !(field.key === 'payload' && entry.payload)
  );
  const payloadField = fields?.find(field => field.key === 'payload');
  return (
    <DetailPane
      ariaLabel={t.viewer.entry.title}
      testId="custom-log-entry-detail"
      dock={dock}
      size={{ right: 'w-[420px]', bottom: 'h-[280px]' }}
      header={
        <>
          <LevelBadge level={entry.level} rawLevel={entry.rawLevel} />
          <b className="min-w-0 flex-1 truncate" title={entry.message}>
            {entry.message.split('\n')[0]}
          </b>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex items-center gap-1"
            title={t.viewer.entry.copyMessage}
            onClick={() => onCopyMessage(entry.message)}
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
            {t.viewer.entry.copyMessage}
          </Button>
          <DetailCloseButton label={t.viewer.entry.close} onClick={onClose} />
        </>
      }
    >
      <Facts>
        <Fact label={t.viewer.entry.sequence} value={String(entry.sequence)} />
        <Fact label={t.viewer.entry.time} value={formatLogTime(entry.time)} />
        <Fact label={t.viewer.entry.origin} value={entry.origin} />
        <Fact label={t.viewer.entry.user} value={entry.user} />
        <Fact label={t.viewer.entry.exception} value={entry.exceptionType} />
        <Fact label={t.viewer.entry.record} value={entry.recordId} />
      </Facts>
      {entry.previewClipped || entry.messageTruncated ? (
        <p className="text-[11px] text-muted-foreground">
          {[
            entry.previewClipped ? t.viewer.entry.clipped : '',
            entry.messageTruncated ? t.viewer.entry.truncatedByLogger : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      <section aria-label={t.viewer.entry.fields} className="flex flex-col gap-1">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground">{t.viewer.entry.fields}</h3>
        {fields === undefined ? (
          loadingFields ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t.viewer.entry.loadingFields}
            </p>
          ) : null
        ) : (
          <ul className="flex flex-col">
            {listed.map(field => (
              <li
                key={field.key}
                className="flex min-h-[26px] items-center gap-2 text-xs"
                data-testid={`entry-field-${field.key}`}
              >
                <span className="min-w-0 flex-1 truncate" title={field.key}>
                  {field.label}
                </span>
                <FieldState t={t} field={field} />
                {field.state === 'value' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`${t.viewer.entry.open} ${field.label}`}
                    onClick={() => onOpenField(field.key)}
                  >
                    {t.viewer.entry.open}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {entry.payload ? (
        <PayloadSection
          t={t}
          payload={entry.payload}
          columns={columns}
          lockedColumns={lockedColumns}
          canOpenFull={payloadField?.state === 'value'}
          onOpenFull={() => onOpenField('payload')}
          onToggleColumn={onToggleColumn}
          onFilterEqual={onFilterEqual}
        />
      ) : null}
    </DetailPane>
  );
}
