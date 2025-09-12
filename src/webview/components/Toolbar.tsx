import React from 'react';
import type { OrgItem } from '../../shared/types';
import { FilterSelect } from './FilterSelect';
import { OrgSelect } from './OrgSelect';
import { commonButtonStyle, inputStyle } from './styles';

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
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
      <button onClick={onRefresh} disabled={loading} style={commonButtonStyle}>
        {loading ? t.loading : t.refresh}
      </button>
      <OrgSelect
        label={t.orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        disabled={loading}
        emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
      />
      <input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.searchPlaceholder ?? 'Search logs…'}
        disabled={loading}
        style={{ ...inputStyle, flex: '1 1 220px', minWidth: 160 }}
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
      <button
        onClick={onClearFilters}
        disabled={loading}
        style={{
          ...commonButtonStyle,
          opacity: filterUser || filterOperation || filterStatus || filterCodeUnit ? 1 : 0.7
        }}
      >
        {t.filters?.clear ?? 'Clear filters'}
      </button>
      {error && <span style={{ color: 'var(--vscode-errorForeground)' }}>{error}</span>}
      {!error && loading && <span>{t.loading}</span>}
    </div>
  );
}
