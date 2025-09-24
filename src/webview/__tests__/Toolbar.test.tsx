import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { Toolbar } from '../components/Toolbar';
import { getMessages } from '../i18n';
import type { OrgItem } from '../../shared/types';

type ToolbarRenderOptions = {
  loading?: boolean;
  error?: string;
  filterUser?: string;
  filterOperation?: string;
  filterStatus?: string;
  filterCodeUnit?: string;
};

function renderToolbar(overrides: ToolbarRenderOptions = {}) {
  const {
    loading = false,
    error,
    filterUser = '',
    filterOperation = '',
    filterStatus = '',
    filterCodeUnit = ''
  } = overrides;

  const t = getMessages('en');
  const orgs: OrgItem[] = [
    { username: 'u1', alias: 'Org 1', isDefaultUsername: true } as OrgItem,
    { username: 'u2', alias: 'Org 2', isDefaultUsername: false } as OrgItem
  ];
  const users = ['User A', 'User B'];
  const operations = ['EXEC', 'QUERY'];
  const statuses = ['Success', 'Failed'];
  const codeUnits = ['UnitA', 'UnitB'];
  let refreshCount = 0;
  let clearCount = 0;
  const queryChanges: string[] = [];
  const userChanges: string[] = [];
  const prefetchChanges: boolean[] = [];

  const docRef = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
  const originalDocumentFragment = docRef.DocumentFragment;
  // Force native selects to simplify interaction semantics in tests
  docRef.DocumentFragment = undefined;
  let view: ReturnType<typeof render>;
  try {
    view = render(
      <Toolbar
        loading={loading}
        error={error}
        onRefresh={() => {
          refreshCount++;
        }}
        t={t}
        orgs={orgs}
        selectedOrg="u1"
        onSelectOrg={() => {}}
        query="initial"
        onQueryChange={value => {
          queryChanges.push(value);
        }}
        users={users}
        operations={operations}
        statuses={statuses}
        codeUnits={codeUnits}
        filterUser={filterUser}
        filterOperation={filterOperation}
        filterStatus={filterStatus}
        filterCodeUnit={filterCodeUnit}
        onFilterUserChange={value => {
          userChanges.push(`user:${value}`);
        }}
        onFilterOperationChange={value => {
          userChanges.push(`op:${value}`);
        }}
        onFilterStatusChange={value => {
          userChanges.push(`status:${value}`);
        }}
        onFilterCodeUnitChange={value => {
          userChanges.push(`code:${value}`);
        }}
        onClearFilters={() => {
          clearCount++;
        }}
        prefetchLogBodies={false}
        onPrefetchChange={value => {
          prefetchChanges.push(value);
        }}
      />
    );
  } finally {
    docRef.DocumentFragment = originalDocumentFragment;
  }

  return {
    view,
    refreshCount: () => refreshCount,
    clearCount: () => clearCount,
    queryChanges,
    userChanges,
    prefetchChanges
  };
}

describe('Toolbar webview component', () => {
  it('disables refresh and inputs while loading and surfaces progress message', () => {
    const utils = renderToolbar({ loading: true });

    const refreshButton = screen.getByRole('button', { name: 'Loading…' });
    expect(refreshButton).toBeDisabled();
    fireEvent.click(refreshButton);
    expect(utils.refreshCount()).toBe(0);

    const searchInput = screen.getByLabelText('Search logs…') as HTMLInputElement;
    expect(searchInput.disabled).toBe(true);

    const loadingNotice = screen.getAllByText('Loading…');
    expect(loadingNotice.length).toBeGreaterThanOrEqual(1);

    const spinner = refreshButton.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
  });

  it('shows error banner and enables clearing when filters are active', () => {
    const utils = renderToolbar({
      error: 'Request failed',
      filterUser: 'User A',
      filterOperation: 'EXEC'
    });

    screen.getByText('Error:');
    screen.getByText('Request failed');

    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    expect(clearButton).not.toBeDisabled();
    fireEvent.click(clearButton);
    expect(utils.clearCount()).toBe(1);

    const userSelect = screen.getByLabelText('User') as HTMLSelectElement;
    fireEvent.change(userSelect, { target: { value: 'User B' } });
    expect(utils.userChanges).toEqual(['user:User B']);
  });

  it('disables clear action when no filters and captures query updates', () => {
    const utils = renderToolbar();
    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    expect(clearButton).toBeDisabled();

    const searchInput = screen.getByLabelText('Search logs…') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'new search' } });
    expect(utils.queryChanges).toEqual(['new search']);
  });

  it('notifies when prefetch toggle changes', () => {
    const utils = renderToolbar();
    const toggle = screen.getByRole('switch', { name: 'Search entire log text' });
    fireEvent.click(toggle);
    expect(utils.prefetchChanges).toEqual([true]);
  });
});
