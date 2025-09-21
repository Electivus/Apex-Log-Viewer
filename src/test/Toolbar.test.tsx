import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { Toolbar } from '../webview/components/Toolbar';
import { getMessages } from '../webview/i18n';
import type { OrgItem } from '../shared/types';

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

  const view = render(
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
    />
  );

  return {
    view,
    refreshCount: () => refreshCount,
    clearCount: () => clearCount,
    queryChanges,
    userChanges
  };
}

suite('Toolbar webview component', () => {
  test('disables refresh and inputs while loading and surfaces progress message', () => {
    const utils = renderToolbar({ loading: true });

    const refreshButton = screen.getByRole('button', { name: 'Loading…' });
    assert.equal(refreshButton.getAttribute('disabled'), '');
    fireEvent.click(refreshButton);
    assert.equal(utils.refreshCount(), 0, 'click ignored while disabled');

    const searchInput = screen.getByLabelText('Search logs…') as HTMLInputElement;
    assert.ok(searchInput.disabled, 'search input should be disabled during loading');

    const loadingNotice = screen.getAllByText('Loading…');
    assert.ok(loadingNotice.length >= 1, 'renders loading copy when busy');

    const spinner = refreshButton.querySelector('.animate-spin');
    assert.ok(spinner, 'refresh button shows spinner icon');
  });

  test('shows error banner and enables clearing when filters are active', () => {
    const utils = renderToolbar({
      error: 'Request failed',
      filterUser: 'User A',
      filterOperation: 'EXEC'
    });

    screen.getByText('Error:');
    screen.getByText('Request failed');

    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    assert.equal(clearButton.getAttribute('disabled'), null);
    fireEvent.click(clearButton);
    assert.equal(utils.clearCount(), 1, 'clear callback invoked');

    const userSelect = screen.getByLabelText('User') as HTMLSelectElement;
    fireEvent.change(userSelect, { target: { value: 'User B' } });
    assert.deepEqual(utils.userChanges, ['user:User B']);
  });

  test('disables clear action when no filters and captures query updates', () => {
    const utils = renderToolbar();
    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    assert.equal(clearButton.getAttribute('disabled'), '', 'clear disabled with no filters');

    const searchInput = screen.getByLabelText('Search logs…') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'new search' } });
    assert.deepEqual(utils.queryChanges, ['new search']);
  });
});
