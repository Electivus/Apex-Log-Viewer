import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bug, Download, ListFilter, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import type { OrgItem } from '@alv/protocol/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { FilterSelect } from './FilterSelect';
import { OrgSelect } from './OrgSelect';
import { ColumnsPopover } from './ColumnsPopover';
import type { NormalizedLogsColumnsConfig } from '@alv/protocol/logsColumns';
import { cn } from '../lib/utils';

const INLINE_SELECT = 'min-w-0 flex-row items-center gap-2';

const POPOVER_SURFACE = cn(
  'z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-lg border border-border bg-card shadow-lg outline-none',
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
);

function useStableId(prefix: string) {
  const id = React.useId();
  return `${prefix}-${id}`;
}

type ToolbarProps = {
  loading: boolean;
  onRefresh: () => void;
  onDownloadAllLogs: () => void;
  onClearLogs: (scope: 'all' | 'mine') => void;
  onOpenDebugFlags: () => void;
  t: any;
  orgs: OrgItem[];
  selectedOrg?: string;
  onSelectOrg: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  onSearchRerun: () => void;
  users: string[];
  operations: string[];
  statuses: string[];
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  errorsOnly: boolean;
  onFilterUserChange: (v: string) => void;
  onFilterOperationChange: (v: string) => void;
  onFilterStatusChange: (v: string) => void;
  onErrorsOnlyChange: (v: boolean) => void;
  onClearFilters: () => void;
  columnsConfig: NormalizedLogsColumnsConfig;
  fullLogSearchEnabled: boolean;
  onColumnsConfigChange: (
    updater: (prev: NormalizedLogsColumnsConfig) => NormalizedLogsColumnsConfig,
    options?: { persist?: boolean }
  ) => void;
};

export function Toolbar({
  loading,
  onRefresh,
  onDownloadAllLogs,
  onClearLogs,
  onOpenDebugFlags,
  t,
  orgs,
  selectedOrg,
  onSelectOrg,
  query,
  onQueryChange,
  onSearchRerun,
  users,
  operations,
  statuses,
  filterUser,
  filterOperation,
  filterStatus,
  errorsOnly,
  onFilterUserChange,
  onFilterOperationChange,
  onFilterStatusChange,
  onErrorsOnlyChange,
  onClearFilters,
  columnsConfig,
  fullLogSearchEnabled,
  onColumnsConfigChange
}: ToolbarProps) {
  const errorsOnlyId = useStableId('logs-errors-only');
  const popoverFilterCount = [filterUser, filterOperation, filterStatus].filter(Boolean).length;
  const searchLabel = t?.searchPlaceholder ?? 'Search logs…';
  const filtersLabel = t?.filters?.button ?? 'Filters';
  const allLabel = t?.filters?.all ?? 'All';
  const downloadAllLabel = t?.downloadAllLogs ?? 'Download all logs';
  const clearLogsLabel = t?.logsCleanup?.open ?? 'Clear logs';
  const clearLogsTitle = t?.logsCleanup?.openTitle ?? 'Delete Apex logs from the selected org';
  const deleteAllLabel = t?.logsCleanup?.deleteAll ?? 'Delete all org logs';
  const deleteMineLabel = t?.logsCleanup?.deleteMine ?? 'Delete my logs';

  return (
    <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
      <OrgSelect
        label={t.orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        disabled={loading}
        emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
        className={INLINE_SELECT}
      />

      <div className="min-w-[160px] max-w-[360px] flex-1">
        <Input
          type="search"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onPaste={event => {
            const input = event.currentTarget;
            setTimeout(() => {
              // Re-run search when the pasted content keeps the same value.
              if (input.value === query) {
                onSearchRerun();
              }
            }, 0);
          }}
          aria-label={searchLabel}
          placeholder={searchLabel}
        />
      </div>

      <div className="flex h-7 items-center gap-2">
        <Switch
          id={errorsOnlyId}
          data-testid="logs-errors-only-switch"
          checked={errorsOnly}
          onCheckedChange={onErrorsOnlyChange}
        />
        <Label
          htmlFor={errorsOnlyId}
          className="cursor-pointer whitespace-nowrap text-[13px] font-medium leading-none text-foreground"
        >
          {t.filters?.errorsOnly ?? 'Errors only'}
        </Label>
      </div>

      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="outline"
            className="flex items-center gap-1.5"
            data-testid="logs-filters-button"
          >
            <ListFilter className="h-4 w-4" aria-hidden="true" />
            <span>{filtersLabel}</span>
            {popoverFilterCount > 0 && (
              <span
                data-testid="logs-filters-count"
                className="rounded-full bg-[var(--vscode-badge-background,var(--primary))] px-1.5 text-[11px] leading-4 text-[var(--vscode-badge-foreground,var(--primary-foreground))]"
              >
                {popoverFilterCount}
              </span>
            )}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            className={cn(POPOVER_SURFACE, 'flex w-[260px] flex-col gap-3 p-3')}
          >
            <FilterSelect
              label={t.filters?.user ?? 'User'}
              value={filterUser}
              onChange={onFilterUserChange}
              options={users}
              allLabel={allLabel}
            />
            <FilterSelect
              label={t.filters?.operation ?? 'Operation'}
              value={filterOperation}
              onChange={onFilterOperationChange}
              options={operations}
              allLabel={allLabel}
            />
            <FilterSelect
              label={t.filters?.status ?? 'Status'}
              value={filterStatus}
              onChange={onFilterStatusChange}
              options={statuses}
              allLabel={allLabel}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onClearFilters}
              disabled={popoverFilterCount === 0}
            >
              {t.filters?.clear ?? 'Clear filters'}
            </Button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <span className="flex-1" />

      <Button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        variant="secondary"
        className="flex items-center gap-2"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        )}
        <span>{t.refresh}</span>
      </Button>

      <Button
        type="button"
        onClick={onOpenDebugFlags}
        disabled={loading}
        variant="ghost"
        className="flex items-center gap-2"
        title={t.debugFlags?.openTitle ?? 'Open debug flags editor'}
        data-testid="logs-open-debug-flags"
      >
        <Bug className="h-4 w-4" aria-hidden="true" />
        <span>{t.debugFlags?.open ?? 'Debug Flags'}</span>
      </Button>

      <Button
        type="button"
        onClick={onDownloadAllLogs}
        disabled={loading}
        variant="ghost"
        size="icon"
        aria-label={downloadAllLabel}
        title={downloadAllLabel}
      >
        <Download className="h-4 w-4" aria-hidden="true" />
      </Button>

      <Popover.Root>
        <Popover.Trigger asChild>
          <Button
            type="button"
            disabled={loading}
            variant="ghost"
            size="icon"
            aria-label={clearLogsLabel}
            title={clearLogsTitle}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className={cn(POPOVER_SURFACE, 'flex w-[220px] flex-col gap-1 p-1.5')}
          >
            <Popover.Close asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => onClearLogs('mine')}
                disabled={loading}
              >
                {deleteMineLabel}
              </Button>
            </Popover.Close>
            <Popover.Close asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start text-destructive hover:text-destructive"
                onClick={() => onClearLogs('all')}
                disabled={loading}
              >
                {deleteAllLabel}
              </Button>
            </Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <ColumnsPopover
        t={t}
        columnsConfig={columnsConfig}
        fullLogSearchEnabled={fullLogSearchEnabled}
        onColumnsConfigChange={onColumnsConfigChange}
      />
    </section>
  );
}
