import React from 'react';
import { render, fireEvent, screen, within } from '@testing-library/react';
import { Toolbar } from '../components/Toolbar';
import { getMessages } from '../i18n';
import type { OrgItem } from '@alv/protocol/types';

const defaultColumnsConfig = {
  order: ['user', 'application', 'operation', 'time', 'duration', 'status', 'size', 'match'],
  visibility: {
    user: true,
    application: true,
    operation: true,
    time: true,
    duration: true,
    status: true,
    size: true,
    match: true
  },
  widths: {}
} as const;

const deprecatedFilterLabel = ['Code', 'Unit'].join(' ');

/** Native selects keep interaction simple in jsdom; Radix selects need browser APIs it lacks. */
function withNativeSelects<T>(run: () => T): T {
  const docRef = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
  const original = docRef.DocumentFragment;
  docRef.DocumentFragment = undefined;
  try {
    return run();
  } finally {
    docRef.DocumentFragment = original;
  }
}

type ToolbarRenderOptions = {
  loading?: boolean;
  filterUser?: string;
  filterOperation?: string;
  filterStatus?: string;
  errorsOnly?: boolean;
  query?: string;
};

function renderToolbar(overrides: ToolbarRenderOptions = {}) {
  const {
    loading = false,
    filterUser = '',
    filterOperation = '',
    filterStatus = '',
    errorsOnly = false,
    query = 'initial'
  } = overrides;

  const t = getMessages('en');
  const orgs: OrgItem[] = [
    { username: 'u1', alias: 'Org 1', isDefaultUsername: true } as OrgItem,
    { username: 'u2', alias: 'Org 2', isDefaultUsername: false } as OrgItem
  ];
  const calls = {
    refresh: 0,
    downloadAll: 0,
    openDebugFlags: 0,
    clear: 0,
    clearLogs: [] as Array<'all' | 'mine'>,
    queries: [] as string[],
    filters: [] as string[],
    errorsOnly: [] as boolean[]
  };

  const view = withNativeSelects(() =>
    render(
      <Toolbar
        loading={loading}
        onRefresh={() => {
          calls.refresh++;
        }}
        onDownloadAllLogs={() => {
          calls.downloadAll++;
        }}
        onOpenDebugFlags={() => {
          calls.openDebugFlags++;
        }}
        onClearLogs={scope => {
          calls.clearLogs.push(scope);
        }}
        t={t}
        orgs={orgs}
        selectedOrg="u1"
        onSelectOrg={() => {}}
        query={query}
        onQueryChange={value => {
          calls.queries.push(value);
        }}
        onSearchRerun={() => {}}
        users={['User A', 'User B']}
        operations={['EXEC', 'QUERY']}
        statuses={['Success', 'Failed']}
        filterUser={filterUser}
        filterOperation={filterOperation}
        filterStatus={filterStatus}
        errorsOnly={errorsOnly}
        onFilterUserChange={value => {
          calls.filters.push(`user:${value}`);
        }}
        onFilterOperationChange={value => {
          calls.filters.push(`op:${value}`);
        }}
        onFilterStatusChange={value => {
          calls.filters.push(`status:${value}`);
        }}
        onErrorsOnlyChange={value => {
          calls.errorsOnly.push(value);
        }}
        onClearFilters={() => {
          calls.clear++;
        }}
        columnsConfig={defaultColumnsConfig as any}
        fullLogSearchEnabled={true}
        onColumnsConfigChange={() => {}}
      />
    )
  );

  const openFilters = () => withNativeSelects(() => fireEvent.click(screen.getByRole('button', { name: /^Filters/ })));

  return { view, calls, openFilters };
}

describe('Toolbar webview component', () => {
  it('is a single bar without a card around it', () => {
    renderToolbar();
    const bar = screen.getByLabelText('Search logs…').closest('section') as HTMLElement;
    expect(bar.className).toContain('border-b');
    expect(bar.className).toContain('flex-wrap');
    expect(bar.className).not.toMatch(/\b(rounded-lg|shadow-sm|bg-card)/);
  });

  it('labels the search box for assistive technology and shows no visible label', () => {
    renderToolbar({ query: '' });
    const search = screen.getByLabelText('Search logs…') as HTMLInputElement;
    expect(search).toHaveAttribute('placeholder', 'Search logs…');
    expect(search.type).toBe('search');
    expect(screen.queryByText('Search logs…')).toBeNull();
  });

  it('keeps search, Errors only and Filters usable while a refresh runs, and disables what it would disturb', () => {
    const utils = renderToolbar({ loading: true });

    expect(screen.getByLabelText('Search logs…')).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Errors only' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Filters/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Columns' })).toBeEnabled();

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toBeDisabled();
    expect(refresh.querySelector('.animate-spin')).not.toBeNull();
    fireEvent.click(refresh);
    expect(utils.calls.refresh).toBe(0);

    for (const name of ['Debug Flags', 'Download all logs', 'Clear logs']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('keeps the Refresh label while loading so the right side of the bar does not move', () => {
    renderToolbar({ loading: true });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Loading…' })).toBeNull();
  });

  it('captures query updates', () => {
    const utils = renderToolbar({ query: '  ' });
    expect(screen.queryByLabelText(deprecatedFilterLabel)).toBeNull();
    fireEvent.change(screen.getByLabelText('Search logs…'), { target: { value: 'new search' } });
    expect(utils.calls.queries).toEqual(['new search']);
  });

  it('refreshes from the toolbar', () => {
    const utils = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(utils.calls.refresh).toBe(1);
  });

  it('toggles errors-only filter and reports changes', () => {
    const utils = renderToolbar();
    fireEvent.click(screen.getByRole('switch', { name: 'Errors only' }));
    expect(utils.calls.errorsOnly).toEqual([true]);
  });

  describe('Filters popover', () => {
    it('keeps User, Operation and Status out of the bar until it opens', () => {
      const utils = renderToolbar();
      expect(screen.queryByLabelText('User')).toBeNull();
      utils.openFilters();
      screen.getByLabelText('User');
      screen.getByLabelText('Operation');
      screen.getByLabelText('Status');
      screen.getByRole('button', { name: 'Clear filters' });
    });

    it('counts the active filters on the button so none is hidden', () => {
      renderToolbar({ filterUser: 'User A', filterOperation: 'EXEC' });
      expect(screen.getByTestId('logs-filters-count')).toHaveTextContent('2');
    });

    it('shows no count while no filter is set, and leaves search and Errors only out of it', () => {
      renderToolbar({ query: 'abc', errorsOnly: true });
      expect(screen.queryByTestId('logs-filters-count')).toBeNull();
    });

    it('reports changes and clears the active filters', () => {
      const utils = renderToolbar({ filterUser: 'User A' });
      utils.openFilters();

      fireEvent.change(screen.getByLabelText('User') as HTMLSelectElement, { target: { value: 'User B' } });
      fireEvent.change(screen.getByLabelText('Status') as HTMLSelectElement, { target: { value: 'Failed' } });
      expect(utils.calls.filters).toEqual(['user:User B', 'status:Failed']);

      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(utils.calls.clear).toBe(1);
    });

    it('disables Clear filters when nothing is filtered', () => {
      const utils = renderToolbar({ query: 'abc', errorsOnly: true });
      utils.openFilters();
      expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled();
    });
  });

  it('triggers debug flags entrypoint from toolbar button', () => {
    const utils = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Debug Flags' }));
    expect(utils.calls.openDebugFlags).toBe(1);
    expect(screen.getByTestId('logs-open-debug-flags')).toHaveTextContent('Debug Flags');
  });

  it('gives each icon-only button an accessible name and a title', () => {
    renderToolbar();
    for (const name of ['Download all logs', 'Clear logs', 'Columns']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('title');
      expect(button.textContent).toBe('');
    }
  });

  it('triggers download all logs entrypoint from toolbar button', () => {
    const utils = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Download all logs' }));
    expect(utils.calls.downloadAll).toBe(1);
  });

  it('opens clear logs menu and triggers selected action', () => {
    const utils = renderToolbar();

    fireEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete my logs' }));
    expect(utils.calls.clearLogs).toEqual(['mine']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete all org logs' }));
    expect(utils.calls.clearLogs).toEqual(['mine', 'all']);
  });
});
