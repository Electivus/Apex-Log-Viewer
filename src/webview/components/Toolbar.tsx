import React from 'react';
import { RefreshCw, FilterX, Loader2, AlertCircle } from 'lucide-react';
import type { OrgItem } from '../../shared/types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { FilterSelect } from './FilterSelect';
import { OrgSelect } from './OrgSelect';

function useStableId(prefix: string) {
  const id = React.useId();
  return `${prefix}-${id}`;
}

type ToolbarProps = {
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  t: any;
  orgs: OrgItem[];
  selectedOrg?: string;
  onSelectOrg: (v: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  users: string[];
  operations: string[];
  statuses: string[];
  codeUnits: string[];
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  filterCodeUnit: string;
  onFilterUserChange: (v: string) => void;
  onFilterOperationChange: (v: string) => void;
  onFilterStatusChange: (v: string) => void;
  onFilterCodeUnitChange: (v: string) => void;
  onClearFilters: () => void;
  prefetchLogBodies: boolean;
  onPrefetchChange: (value: boolean) => void;
};

export function Toolbar({
  loading,
  error,
  onRefresh,
  t,
  orgs,
  selectedOrg,
  onSelectOrg,
  query,
  onQueryChange,
  users,
  operations,
  statuses,
  codeUnits,
  filterUser,
  filterOperation,
  filterStatus,
  filterCodeUnit,
  onFilterUserChange,
  onFilterOperationChange,
  onFilterStatusChange,
  onFilterCodeUnitChange,
  onClearFilters,
  prefetchLogBodies,
  onPrefetchChange
}: ToolbarProps) {
  const searchInputId = useStableId('logs-search');
  const prefetchSwitchId = useStableId('prefetch');
  const hasFilters = Boolean(filterUser || filterOperation || filterStatus || filterCodeUnit);
  const errorLabel = t?.tail?.errorLabel ?? t?.errors?.generic ?? 'Error';

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

        <OrgSelect
          label={t.orgLabel}
          orgs={orgs}
          selected={selectedOrg}
          onChange={onSelectOrg}
          disabled={loading}
          emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
        />

        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <Label htmlFor={searchInputId}>{t.searchPlaceholder ?? 'Search logs…'}</Label>
          <Input
            id={searchInputId}
            type="search"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={t.searchPlaceholder ?? 'Search logs…'}
            disabled={loading}
          />
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm">
          <Switch
            id={prefetchSwitchId}
            checked={prefetchLogBodies}
            onCheckedChange={value => onPrefetchChange(!!value)}
            disabled={loading}
            aria-label={t.prefetchLabel ?? 'Search entire log text'}
          />
          <div className="flex flex-col leading-tight">
            <Label
              htmlFor={prefetchSwitchId}
              className="text-xs font-semibold text-muted-foreground"
              title={t.prefetchDescription}
            >
              {t.prefetchLabel ?? 'Search entire log text'}
            </Label>
          </div>
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

      {!error && loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{t.loading}</span>
        </div>
      )}
    </section>
  );
}
