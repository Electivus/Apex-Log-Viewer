import React from 'react';
import type { OrgItem } from '../../shared/types';
import { FilterSelect } from './FilterSelect';

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid var(--vscode-button-border, transparent)',
  background: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  cursor: 'pointer'
};

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
      <button onClick={onRefresh} disabled={loading} style={buttonStyle}>
        {loading ? t.loading : t.refresh}
      </button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ opacity: 0.8 }}>{t.orgLabel}:</span>
        <select
          value={selectedOrg ?? (orgs[0]?.username || '')}
          onChange={e => onSelectOrg(e.target.value)}
          disabled={loading}
          style={{
            background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
            color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
            border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
            padding: '2px 6px',
            borderRadius: 4
          }}
        >
          {orgs.map(o => (
            <option key={o.username} value={o.username}>
              {(o.alias ?? o.username) + (o.isDefaultUsername ? ' *' : '')}
            </option>
          ))}
        </select>
      </label>
      {orgs.length === 0 && (
        <span style={{ opacity: 0.7 }} aria-live="polite">{t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}</span>
      )}
      <input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.searchPlaceholder ?? 'Search logs…'}
        disabled={loading}
        style={{
          flex: '1 1 220px',
          minWidth: 160,
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid var(--vscode-input-border)',
          background: 'var(--vscode-input-background)',
          color: 'var(--vscode-input-foreground)'
        }}
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
        style={{ ...buttonStyle, opacity: filterUser || filterOperation || filterStatus || filterCodeUnit ? 1 : 0.7 }}
      >
        {t.filters?.clear ?? 'Clear filters'}
      </button>
      {error && <span style={{ color: 'var(--vscode-errorForeground)' }}>{error}</span>}
      {!error && loading && <span>{t.loading}</span>}
    </div>
  );
}
