import React, { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { fillTemplate } from '../../utils/customLogs/format';
import type { DiscoveredField } from '../../utils/customLogs/payloadRows';
import { Input } from '../ui/input';

export const PAYLOAD_TYPE_LABEL_KEY = {
  string: 'typeString',
  number: 'typeNumber',
  boolean: 'typeBoolean',
  mixed: 'typeMixed',
  null: 'typeNull'
} as const;

export const PAYLOAD_TYPE_TONE: Record<DiscoveredField['type'], string> = {
  string: 'text-[color:var(--vscode-debugTokenExpression-string,#ce9178)]',
  number: 'text-[color:var(--vscode-debugTokenExpression-number,#b5cea8)]',
  boolean: 'text-[color:var(--vscode-debugTokenExpression-boolean,#569cd6)]',
  mixed: 'text-amber-400',
  null: 'text-muted-foreground'
};

type PayloadFieldPickerProps = {
  t: CustomLogsMessages;
  fields: readonly DiscoveredField[];
  /** Paths that are columns now, and the ones the project mapping pins. */
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  onToggleColumn: (path: string) => void;
  /** The header cell that opens the picker. */
  children: React.ReactNode;
};

/** The `+ Field` popover: a searchable list of every payload path seen in the loaded rows. */
export function PayloadFieldPicker({ t, fields, columns, lockedColumns, onToggleColumn, children }: PayloadFieldPickerProps) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return fields
      .filter(field => field.path.toLowerCase().includes(needle))
      .sort((a, b) => Number(columns.has(b.path)) - Number(columns.has(a.path)) || b.rows - a.rows || a.path.localeCompare(b.path));
  }, [columns, fields, query]);

  return (
    <Popover.Root onOpenChange={open => open && setQuery('')}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[360px] flex-col rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg outline-none"
        >
          <div className="px-2.5 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
            {fillTemplate(t.picker.title, { shown: matches.length, total: fields.length })}
          </div>
          <div className="px-2 pb-1.5">
            <Input
              autoFocus
              type="search"
              value={query}
              aria-label={fillTemplate(t.picker.search, { count: fields.length })}
              placeholder={fillTemplate(t.picker.search, { count: fields.length })}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                const first = matches[0];
                if (event.key === 'Enter' && first && !lockedColumns.has(first.path)) {
                  event.preventDefault();
                  onToggleColumn(first.path);
                }
              }}
            />
          </div>
          <div role="group" aria-label={t.table.addFieldTitle} className="min-h-0 flex-1 overflow-auto">
            {matches.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">{t.picker.empty}</p>
            ) : (
              matches.map(field => {
                const checked = columns.has(field.path);
                const locked = lockedColumns.has(field.path);
                return (
                  <button
                    key={field.path}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    disabled={locked}
                    title={locked ? t.table.fromProject : undefined}
                    className="flex h-[22px] w-full items-center gap-2 px-2.5 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none disabled:opacity-70"
                    onClick={() => onToggleColumn(field.path)}
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-muted-foreground/60',
                        checked && 'border-primary bg-primary text-primary-foreground'
                      )}
                      aria-hidden="true"
                    >
                      {checked ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{field.path}</span>
                    <span className={cn('rounded bg-muted px-1.5 font-mono text-[10px]', PAYLOAD_TYPE_TONE[field.type])}>
                      {t.picker[PAYLOAD_TYPE_LABEL_KEY[field.type]]}
                    </span>
                    <span className="h-[5px] w-9 shrink-0 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                      <i className="block h-full bg-[color:var(--vscode-charts-blue,#4e7fb3)]" style={{ width: `${field.share}%` }} />
                    </span>
                    <span className="w-8 text-right text-[11px] text-muted-foreground">{field.share}%</span>
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
