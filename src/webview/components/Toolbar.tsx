import React from 'react';
import { Loader2 } from 'lucide-react';
import type { OrgItem } from '../../shared/types';
import { FilterSelect } from './FilterSelect';
import { OrgSelect } from './OrgSelect';
import { Button } from './ui/button';
import { Input } from './ui/input';

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
  // Filters
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
  onClearFilters
}: ToolbarProps) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 md:gap-3">
      <Button onClick={onRefresh} disabled={loading} className="min-w-[90px]">
        {loading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t.loading}
          </span>
        ) : (
          t.refresh
        )}
      </Button>
      <OrgSelect
        label={t.orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        disabled={loading}
        emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
      />
      <Input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.searchPlaceholder ?? 'Search logs…'}
        disabled={loading}
        className="min-w-[10rem] flex-1 md:max-w-xs"
      />
      {/* Filters */}
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
        onClick={onClearFilters}
        disabled={loading || !(filterUser || filterOperation || filterStatus || filterCodeUnit || query)}
        variant="outline"
        className="min-w-[120px]"
      >
        {t.filters?.clear ?? 'Clear filters'}
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
      {!error && loading && <span className="text-sm text-muted-foreground">{t.loading}</span>}
    </div>
  );
}
