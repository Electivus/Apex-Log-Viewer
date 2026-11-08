import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ListFilter } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import type { FilterKey, FilterMenuModel } from '../../utils/customLogs/serverFilter';
import { LabeledSelect } from '../LabeledSelect';
import { Button } from '../ui/button';

type CustomLogsFiltersProps = {
  t: CustomLogsMessages;
  model: FilterMenuModel;
  onChange: (key: FilterKey, value: string) => void;
  onClear: () => void;
};

/** The server filter: each change reloads the list from Salesforce or from the event store. */
export function CustomLogsFilters({ t, model, onChange, onClear }: CustomLogsFiltersProps) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="flex items-center gap-1.5"
          data-testid="custom-logs-filters-button"
        >
          <ListFilter className="h-4 w-4" aria-hidden="true" />
          <span>{t.filters.button}</span>
          {model.activeCount > 0 ? (
            <span
              data-testid="custom-logs-filters-count"
              className="rounded-full bg-[var(--vscode-badge-background,var(--primary))] px-1.5 text-[11px] leading-4 text-[var(--vscode-badge-foreground,var(--primary-foreground))]"
            >
              {model.activeCount}
            </span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className={cn(
            'z-50 flex max-h-[var(--radix-popover-content-available-height)] w-[280px] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        >
          {model.fields.map(field => (
            <LabeledSelect
              key={field.key}
              label={field.label}
              value={field.value}
              onChange={value => onChange(field.key, value)}
              options={field.options}
              placeholderLabel={field.anyLabel}
              testId={`custom-logs-filter-${field.key}`}
              triggerClassName="min-w-0 w-full"
            />
          ))}
          <p className="text-xs text-muted-foreground">{model.note}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={onClear}
            disabled={model.activeCount === 0}
          >
            {t.filters.clear}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
