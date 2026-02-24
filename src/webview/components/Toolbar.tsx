import React from 'react';
import { RefreshCw, FilterX, Loader2, AlertCircle, Bug, Download } from 'lucide-react';
import type { OrgItem } from '../../shared/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { FilterSelect } from './FilterSelect';
import { OrgSelect } from './OrgSelect';
import { ColumnsPopover } from './ColumnsPopover';
import type { NormalizedLogsColumnsConfig } from '../../shared/logsColumns';

function useStableId(prefix: string) {
  const id = React.useId();
  return `${prefix}-${id}`;
}

type ToolbarProps = {
  loading: boolean;
  error?: string;
  warning?: string;
  onRefresh: () => void;
  onDownloadAllLogs: () => void;
  onOpenDebugFlags: () => void;
  t: any;
  orgs: OrgItem[];
  selectedOrg?: string;
  onSelectOrg: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  searchLoading: boolean;
  searchMessage?: string;
  users: string[];
  operations: string[];
  statuses: string[];
  codeUnits: string[];
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  filterCodeUnit: string;
  errorsOnly: boolean;
  onFilterUserChange: (v: string) => void;
  onFilterOperationChange: (v: string) => void;
  onFilterStatusChange: (v: string) => void;
  onFilterCodeUnitChange: (v: string) => void;
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
  error,
  warning,
  onRefresh,
  onDownloadAllLogs,
  onOpenDebugFlags,
  t,
  orgs,
  selectedOrg,
  onSelectOrg,
  query,
  onQueryChange,
  searchLoading,
  searchMessage,
  users,
  operations,
  statuses,
  codeUnits,
  filterUser,
  filterOperation,
  filterStatus,
  filterCodeUnit,
  errorsOnly,
  onFilterUserChange,
  onFilterOperationChange,
  onFilterStatusChange,
  onFilterCodeUnitChange,
  onErrorsOnlyChange,
  onClearFilters,
  columnsConfig,
  fullLogSearchEnabled,
  onColumnsConfigChange
}: ToolbarProps) {
  const searchInputId = useStableId('logs-search');
  const errorsOnlyId = useStableId('logs-errors-only');
  const hasFilters = Boolean(filterUser || filterOperation || filterStatus || filterCodeUnit || errorsOnly);
  const errorLabel = t?.tail?.errorLabel ?? t?.errors?.generic ?? 'Error';
  const warningLabel = t?.warningLabel ?? 'Warning';

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card/60 p-4 shadow-sm">
      <div className="flex w-full flex-wrap items-end gap-3">
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
          <span>{loading ? t.loading : t.refresh}</span>
        </Button>

        <Button
          type="button"
          onClick={onDownloadAllLogs}
          disabled={loading}
          variant="secondary"
          className="flex items-center gap-2"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>{t.downloadAllLogs ?? 'Download all logs'}</span>
        </Button>

        <OrgSelect
          label={t.orgLabel}
          orgs={orgs}
          selected={selectedOrg}
          onChange={onSelectOrg}
          disabled={loading}
          emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
        />

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

        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <Label htmlFor={searchInputId}>{t.searchPlaceholder ?? 'Search logs…'}</Label>
          <Input
            id={searchInputId}
            type="search"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onPaste={event => {
              const input = event.currentTarget;
              setTimeout(() => {
                // Re-run search when the pasted content keeps the same value.
                if (input.value === query) {
                  onQueryChange(input.value);
                }
              }, 0);
            }}
            placeholder={t.searchPlaceholder ?? 'Search logs…'}
            disabled={loading}
          />
          {(searchLoading || searchMessage) && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {searchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-3 w-3" aria-hidden="true" />
              )}
              <span>{searchMessage ?? t.loading}</span>
            </div>
          )}
        </div>

        <FilterSelect
          label={t.filters?.user ?? 'User'}
          value={filterUser}
          onChange={onFilterUserChange}
          options={users}
          allLabel={t.filters?.all ?? 'All'}
          disabled={loading}
        />
        <FilterSelect
          label={t.filters?.operation ?? 'Operation'}
          value={filterOperation}
          onChange={onFilterOperationChange}
          options={operations}
          allLabel={t.filters?.all ?? 'All'}
          disabled={loading}
        />
        <FilterSelect
          label={t.filters?.status ?? 'Status'}
          value={filterStatus}
          onChange={onFilterStatusChange}
          options={statuses}
          allLabel={t.filters?.all ?? 'All'}
          disabled={loading}
        />
        <FilterSelect
          label={t.columns?.codeUnitStarted ?? 'Code Unit'}
          value={filterCodeUnit}
          onChange={onFilterCodeUnitChange}
          options={codeUnits}
          allLabel={t.filters?.all ?? 'All'}
          disabled={loading}
        />
        <div className="flex h-[28px] min-w-[160px] items-center gap-2 rounded-md border border-input bg-input px-3">
          <Switch
            id={errorsOnlyId}
            data-testid="logs-errors-only-switch"
            checked={errorsOnly}
            onCheckedChange={onErrorsOnlyChange}
            disabled={loading}
          />
          <Label
            htmlFor={errorsOnlyId}
            className="cursor-pointer text-[13px] font-medium leading-none text-muted-foreground"
          >
            {t.filters?.errorsOnly ?? 'Errors only'}
          </Label>
        </div>

        <ColumnsPopover
          t={t}
          columnsConfig={columnsConfig}
          fullLogSearchEnabled={fullLogSearchEnabled}
          onColumnsConfigChange={onColumnsConfigChange}
        />

        <Button
          type="button"
          onClick={onClearFilters}
          disabled={!hasFilters || loading}
          variant="outline"
          className="flex items-center gap-2"
        >
          <FilterX className="h-4 w-4" aria-hidden="true" />
          <span>{t.filters?.clear ?? 'Clear filters'}</span>
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="font-semibold">{errorLabel}:</span>
          <span>{error}</span>
        </div>
      )}

      {!error && warning && (
        <div
          className="flex items-center gap-2 text-sm text-[color:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow))]"
          role="status"
        >
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="font-semibold">{warningLabel}:</span>
          <span>{warning}</span>
        </div>
      )}

      {!error && !warning && loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{t.loading}</span>
        </div>
      )}
    </section>
  );
}
