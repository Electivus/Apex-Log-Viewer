import React, { useCallback, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Columns3, ChevronDown, ChevronUp, RotateCcw, GripVertical } from 'lucide-react';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { cn } from '../lib/utils';
import type { LogsColumnKey, NormalizedLogsColumnsConfig } from '../../shared/logsColumns';
import { DEFAULT_LOGS_COLUMNS_CONFIG, normalizeLogsColumnsConfig } from '../../shared/logsColumns';
import { getLogsColumnLabel } from '../utils/logsColumns';

type Props = {
  t: any;
  columnsConfig: NormalizedLogsColumnsConfig;
  fullLogSearchEnabled: boolean;
  onColumnsConfigChange: (
    updater: (prev: NormalizedLogsColumnsConfig) => NormalizedLogsColumnsConfig,
    options?: { persist?: boolean }
  ) => void;
};

export function ColumnsPopover({ t, columnsConfig, fullLogSearchEnabled, onColumnsConfigChange }: Props) {
  const title = t?.columnsConfig?.title ?? t?.columnsConfig?.button ?? 'Columns';
  const buttonLabel = t?.columnsConfig?.button ?? 'Columns';
  const resetLabel = t?.columnsConfig?.reset ?? 'Reset to defaults';
  const matchDisabledHint = t?.columnsConfig?.matchRequiresFullSearch ?? 'Requires full log search';

  const orderedKeys = useMemo(() => columnsConfig.order, [columnsConfig.order]);

  const moveColumn = useCallback(
    (key: LogsColumnKey, delta: -1 | 1) => {
      onColumnsConfigChange(prev => {
        const index = prev.order.indexOf(key);
        if (index < 0) return prev;
        const targetIndex = index + delta;
        if (targetIndex < 0 || targetIndex >= prev.order.length) return prev;
        const nextOrder = prev.order.slice();
        nextOrder.splice(index, 1);
        nextOrder.splice(targetIndex, 0, key);
        return { ...prev, order: nextOrder };
      });
    },
    [onColumnsConfigChange]
  );

  const setVisible = useCallback(
    (key: LogsColumnKey, visible: boolean) => {
      onColumnsConfigChange(prev => ({ ...prev, visibility: { ...prev.visibility, [key]: visible } }));
    },
    [onColumnsConfigChange]
  );

  const resetToDefaults = useCallback(() => {
    onColumnsConfigChange(() => normalizeLogsColumnsConfig(DEFAULT_LOGS_COLUMNS_CONFIG));
  }, [onColumnsConfigChange]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button type="button" variant="outline" className="flex items-center gap-2">
          <Columns3 className="h-4 w-4" aria-hidden="true" />
          <span>{buttonLabel}</span>
        </Button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className={cn(
            'z-50 w-[320px] rounded-lg border border-border bg-card p-3 shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t?.columnsConfig?.subtitle ?? 'Show/hide and reorder columns'}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-1">
            {orderedKeys.map((key, idx) => {
              const label = getLogsColumnLabel(key, t);
              const isMatch = key === 'match';
              const matchDisabled = isMatch && !fullLogSearchEnabled;
              const checked = columnsConfig.visibility[key] !== false;
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5',
                    'hover:bg-muted/40'
                  )}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-foreground">{label}</span>
                      {matchDisabled && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {matchDisabledHint}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => moveColumn(key, -1)}
                      disabled={idx === 0}
                      aria-label={t?.columnsConfig?.moveUp ?? 'Move up'}
                      title={t?.columnsConfig?.moveUp ?? 'Move up'}
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => moveColumn(key, 1)}
                      disabled={idx === orderedKeys.length - 1}
                      aria-label={t?.columnsConfig?.moveDown ?? 'Move down'}
                      title={t?.columnsConfig?.moveDown ?? 'Move down'}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>

                  <Switch
                    checked={checked}
                    onCheckedChange={v => setVisible(key, !!v)}
                    disabled={matchDisabled}
                    aria-label={label}
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <Button type="button" variant="outline" size="sm" onClick={resetToDefaults} className="gap-2">
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              <span>{resetLabel}</span>
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

