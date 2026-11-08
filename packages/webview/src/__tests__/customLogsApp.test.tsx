import { fireEvent, screen } from '@testing-library/react';
import type { CustomLogSourceView } from '@alv/protocol/customLogsTypes';

import {
  appLog,
  filterOptions,
  filterSelect,
  filtersButton,
  headerLabels,
  ids,
  inFilters,
  lastPost,
  listedTitles,
  makeRow,
  mountApp,
  nebula,
  parsed,
  posts,
  removeMountSequenceMeta,
  rows,
  search,
  searchInput,
  send,
  withNativeSelects
} from './customLogsTestKit';

jest.mock('react-window', () => {
  const React = require('react');
  return {
    List: ({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) => {
      const items = Array.from({ length: rowCount }).map((_: unknown, index: number) =>
        React.createElement(
          React.Fragment,
          { key: index },
          rowComponent({
            ...rowProps,
            index,
            style: { height: typeof rowHeight === 'function' ? rowHeight(index) : rowHeight }
          })
        )
      );
      const api = { element: null, scrollToRow: () => {} };
      // Like react-window's List: the handle reaches object and callback refs alike.
      React.useImperativeHandle(listRef, () => api, []);
      return React.createElement('div', { 'data-testid': 'virtual-list', style, className }, items);
    }
  };
});

afterEach(removeMountSequenceMeta);

const auditLog: CustomLogSourceView = {
  ...appLog,
  id: 'audit-log',
  label: 'Audit Log',
  capabilities: { levelFilter: false, userFilter: false, apexLogLink: false },
  entryCapabilities: { levelFilter: false, userFilter: false }
};

describe('Custom Logs app', () => {
  describe('startup', () => {
    it('echoes the mount sequence when it announces itself', () => {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'alv-mount-sequence');
      meta.setAttribute('content', '7');
      document.head.appendChild(meta);
      const { posted } = mountApp();

      expect(posted[0]).toEqual({ type: 'customLogsReady', mountSequence: 7 });
    });

    it('announces itself without a sequence when the page has none', () => {
      const { posted } = mountApp();

      expect(posted[0]).toEqual({ type: 'customLogsReady' });
    });

    it('lists the rows the host delivered, with the source columns', () => {
      mountApp();

      expect(listedTitles()).toEqual(rows.map(row => row.title));
      expect(headerLabels()).toEqual(['Time', 'Level', 'Title', 'User', 'Category']);
    });

    it('shows a null record field as an empty cell, not the word null', () => {
      mountApp({ rows: [makeRow(ids.ok, 'Order synced', { extra: { Category__c: null } })] });

      expect(screen.queryByText('null')).toBeNull();
      expect(screen.getByTestId('custom-logs-root')).toHaveTextContent('—');
    });

    it('counts the loaded rows in the singular and the plural', () => {
      const { bus } = mountApp();
      const loaded = (count: number) =>
        send(bus, {
          type: 'customLogsPage',
          mode: 'replace',
          columns: [],
          rows: rows.slice(0, count),
          payloadFields: [],
          hasMore: false
        });

      loaded(1);
      expect(screen.getByRole('status')).toHaveTextContent('1 row loaded');
      expect(screen.getByRole('status')).not.toHaveTextContent('1 rows loaded');

      loaded(2);
      expect(screen.getByRole('status')).toHaveTextContent('2 rows loaded');

      send(bus, { type: 'customLogsInit', locale: 'pt-BR' });
      loaded(1);
      expect(screen.getByRole('status')).toHaveTextContent('1 linha carregada');
    });

    it('speaks Portuguese when the host says so', () => {
      const { bus } = mountApp();
      send(bus, { type: 'customLogsInit', locale: 'pt-BR' });

      expect(screen.getByRole('button', { name: /Atualizar/ })).toBeInTheDocument();
      expect(screen.getByRole('searchbox', { name: 'Buscar nas linhas carregadas' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Filtros/ })).toBeInTheDocument();
    });

    it('asks the host for the next page from the status bar', () => {
      const { posted } = mountApp({ hasMore: true });

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

      expect(posts(posted, 'customLogsLoadMore')).toHaveLength(1);
    });

    it('appends the next page after the rows already loaded', () => {
      const { bus } = mountApp({ hasMore: true });

      send(bus, {
        type: 'customLogsPage',
        mode: 'append',
        columns: [{ key: 'Category__c', label: 'Category' }],
        rows: [makeRow('a0B5g00000Zt1Q1EAJ', 'Second page row')],
        payloadFields: [],
        hasMore: false
      });

      expect(listedTitles().at(-1)).toBe('Second page row');
      expect(listedTitles()).toHaveLength(rows.length + 1);
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });
  });

  describe('search over loaded rows', () => {
    it('narrows the loaded rows as the user types, asks Salesforce for nothing, and counts the matches', () => {
      const { posted } = mountApp();
      const before = posted.length;

      search('SYNC ord-1042');

      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);
      expect(screen.getByRole('status')).toHaveTextContent('2 of 8 loaded rows match');
      expect(posted.slice(before)).toEqual([]);
    });

    it('finds the JSON paths and values, the record columns and the level of a row', () => {
      mountApp();

      search('http.status 502');
      expect(listedTitles()).toEqual(['Order sync failed']);

      search('tags[1] beta');
      expect(listedTitles()).toEqual(['Order sync failed']);

      search('orders warn');
      expect(listedTitles()).toEqual(['Retrying order sync']);
    });

    it('reads operators and quotes as plain text, and says when nothing loaded matches', () => {
      mountApp({ hasMore: true });

      search('http.status >= 500');

      expect(listedTitles()).toEqual([]);
      expect(
        screen.getByText('No loaded row matches. Only 8 rows are loaded. Use Load more to widen the search.')
      ).toBeInTheDocument();
    });

    it('offers Load more to search older rows while the host has more and some rows do not match', () => {
      const { bus } = mountApp({ hasMore: true });

      search('ORD-1043');
      expect(screen.getByRole('status')).toHaveTextContent('1 of 8 loaded rows match · Load more to search older rows');

      search('integration@acme.com');
      expect(screen.getByRole('status')).toHaveTextContent('8 of 8 loaded rows match');
      expect(screen.getByRole('status')).not.toHaveTextContent('Load more to search older rows');

      search('ORD-1043');
      send(bus, { type: 'customLogsPage', mode: 'append', columns: [], rows: [], payloadFields: [], hasMore: false });
      expect(screen.getByRole('status')).not.toHaveTextContent('Load more to search older rows');
    });

    it('searches the rows Load more appends with the same search', () => {
      const { bus } = mountApp({ hasMore: true });
      search('ORD-1043');

      send(bus, {
        type: 'customLogsPage',
        mode: 'append',
        columns: [],
        rows: [makeRow('a0B5g00000Zt1Q1EAJ', 'Older order', { payload: parsed({ orderId: 'ORD-1043' }) })],
        payloadFields: [],
        hasMore: false
      });

      expect(searchInput()).toHaveValue('ORD-1043');
      expect(listedTitles()).toEqual(['Order synced', 'Older order']);
    });

    it('clears the search with its button', () => {
      mountApp();
      search('ORD-1043');

      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

      expect(searchInput()).toHaveValue('');
      expect(listedTitles()).toHaveLength(rows.length);
      expect(screen.getByRole('status')).toHaveTextContent('8 rows loaded');
    });

    it('focuses the search on /, unless the user is typing in another field', () => {
      mountApp();
      const other = document.body.appendChild(document.createElement('input'));

      fireEvent.keyDown(other, { key: '/' });
      expect(searchInput()).not.toHaveFocus();

      fireEvent.keyDown(document.body, { key: '/' });
      expect(searchInput()).toHaveFocus();
      other.remove();
    });

    it('keeps the search when the app is restored, and drops JSON filters an older version saved', () => {
      const first = mountApp();
      search('ORD-1043');
      const saved = first.getSavedState();
      first.view.unmount();

      mountApp({}, saved);
      expect(searchInput()).toHaveValue('ORD-1043');
      expect(listedTitles()).toEqual(['Order synced']);
    });

    it('lists every row for a saved state that only has the JSON filters of an older version', () => {
      mountApp({}, { payloadFilters: [{ field: 'orderId', op: '=', value: 'ORD-1043' }], hiddenDefaults: [] });

      expect(searchInput()).toHaveValue('');
      expect(listedTitles()).toHaveLength(rows.length);
    });

    it('clears the search when the host switches source, and keeps it across a refresh', () => {
      const { bus } = mountApp({ sources: [appLog, nebula], selected: 'app-log' });
      search('ORD-1043');

      send(bus, { type: 'customLogsPage', mode: 'replace', columns: [], rows, payloadFields: [], hasMore: false });
      expect(searchInput()).toHaveValue('ORD-1043');
      expect(listedTitles()).toEqual(['Order synced']);

      send(bus, { type: 'customLogsSources', data: [appLog, nebula], selected: 'nebula', issues: [] });
      send(bus, {
        type: 'customLogsPage',
        mode: 'replace',
        columns: [],
        rows: [makeRow('a015g00000Q2xYzAAB', 'Log-000739')],
        payloadFields: [],
        hasMore: false
      });

      expect(searchInput()).toHaveValue('');
      expect(listedTitles()).toEqual(['Log-000739']);
    });

    it('switches source from the picker with no filter in the message, and keeps a search typed meanwhile', () => {
      const { bus, posted } = mountApp({ sources: [appLog, nebula], selected: 'app-log' });

      withNativeSelects(() => {
        search('ORD-1043');
        fireEvent.change(screen.getByTestId('custom-logs-source'), { target: { value: 'nebula' } });
      });
      expect(lastPost(posted, 'customLogsSelectSource')).toEqual({
        type: 'customLogsSelectSource',
        sourceId: 'nebula'
      });
      expect(searchInput()).toHaveValue('');

      search('Log-000739');
      send(bus, { type: 'customLogsSources', data: [appLog, nebula], selected: 'nebula', issues: [] });
      send(bus, {
        type: 'customLogsPage',
        mode: 'replace',
        columns: [],
        rows: [makeRow('a015g00000Q2xYzAAB', 'Log-000739'), makeRow('a015g00000Q2xZ0AAB', 'Log-000740')],
        payloadFields: [],
        hasMore: false
      });

      expect(searchInput()).toHaveValue('Log-000739');
      expect(listedTitles()).toEqual(['Log-000739']);
    });

    it('hides the source picker when only one source is ready', () => {
      mountApp();

      expect(screen.queryByTestId('custom-logs-source')).toBeNull();
    });

    it('lists a path that only the second page carries in + Field, and finds its value', () => {
      const { bus } = mountApp();
      send(bus, {
        type: 'customLogsPage',
        mode: 'append',
        columns: [{ key: 'Category__c', label: 'Category' }],
        rows: [makeRow('a0B5g00000Zt1Q1EAJ', 'Second page row', { payload: parsed({ region: 'us-east' }) })],
        payloadFields: [{ path: 'region', types: ['string'], rows: 1 }],
        hasMore: false
      });

      search('us-east');
      expect(listedTitles()).toEqual(['Second page row']);

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));
      expect(screen.getByRole('menuitemcheckbox', { name: /region/ })).toBeInTheDocument();
    });
  });

  describe('Filters menu', () => {
    const usersRows = [
      makeRow(ids.failed, 'Order sync failed', { user: 'zoe@acme.com' }),
      makeRow(ids.retry, 'Retrying order sync', { user: 'ana@acme.com' }),
      makeRow(ids.ok, 'Order synced', { user: 'zoe@acme.com' })
    ];

    it('offers Level, Logged by and Time, with the users of the loaded rows', () => {
      mountApp({ rows: usersRows });

      inFilters(() => {
        expect(filterOptions('Level')).toEqual([
          'Any level',
          'ERROR and above',
          'WARN and above',
          'INFO and above',
          'DEBUG and above',
          'FINE and above',
          'FINER and above',
          'FINEST and above'
        ]);
        expect(filterOptions('Logged by')).toEqual(['Anyone', 'ana@acme.com', 'zoe@acme.com']);
        expect(filterOptions('Time')).toEqual(['Any time', 'Last hour', 'Last 24 hours', 'Last 7 days']);
        expect(screen.getByText('Runs in Salesforce: changes the query and reloads the list.')).toBeInTheDocument();
      });
    });

    it('still offers every user it has listed after one is picked and the list reloads with that user only', () => {
      const { bus, posted } = mountApp({ rows: usersRows, hasMore: true });
      send(bus, {
        type: 'customLogsPage',
        mode: 'append',
        columns: [],
        rows: [makeRow('a0B5g00000Zt1Q1EAJ', 'Older order', { user: 'bob@acme.com' })],
        payloadFields: [],
        hasMore: false
      });

      inFilters(() => fireEvent.change(filterSelect('Logged by'), { target: { value: 'ana@acme.com' } }));
      send(bus, { type: 'customLogsFilter', value: { user: 'ana@acme.com' } });
      send(bus, {
        type: 'customLogsPage',
        mode: 'replace',
        columns: [],
        rows: [makeRow(ids.retry, 'Retrying order sync', { user: 'ana@acme.com' })],
        payloadFields: [],
        hasMore: false
      });
      expect(listedTitles()).toEqual(['Retrying order sync']);

      inFilters(() => {
        expect(filterSelect('Logged by')).toHaveValue('ana@acme.com');
        expect(filterOptions('Logged by')).toEqual(['Anyone', 'ana@acme.com', 'bob@acme.com', 'zoe@acme.com']);
        fireEvent.change(filterSelect('Logged by'), { target: { value: 'zoe@acme.com' } });
      });
      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
        type: 'customLogsSetFilter',
        filter: { user: 'zoe@acme.com' }
      });
    });

    it('offers only the users of the new source or org after a switch', () => {
      const { bus } = mountApp({ sources: [appLog, nebula], selected: 'app-log', rows: usersRows });
      const page = (user: string) =>
        send(bus, {
          type: 'customLogsPage',
          mode: 'replace',
          columns: [],
          rows: [makeRow('a015g00000Q2xYzAAB', 'Log-000739', { user })],
          payloadFields: [],
          hasMore: false
        });

      withNativeSelects(() => {
        fireEvent.change(screen.getByTestId('custom-logs-source'), { target: { value: 'nebula' } });
      });
      send(bus, { type: 'customLogsSources', data: [appLog, nebula], selected: 'nebula', issues: [] });
      page('dev@acme.com');
      inFilters(() => expect(filterOptions('Logged by')).toEqual(['Anyone', 'dev@acme.com']));

      send(bus, {
        type: 'customLogsOrgs',
        data: [
          { username: 'dev@acme.com', alias: 'acme-dev' },
          { username: 'qa@acme.com', alias: 'acme-qa' }
        ],
        selected: 'qa@acme.com'
      });
      page('kim@acme.com');
      inFilters(() => expect(filterOptions('Logged by')).toEqual(['Anyone', 'kim@acme.com']));
    });

    it('posts the whole server filter on each change, and counts the set filters on the button', () => {
      const { bus, posted } = mountApp({ rows: usersRows });

      inFilters(() => {
        fireEvent.change(filterSelect('Level'), { target: { value: 'WARN' } });
      });
      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
        type: 'customLogsSetFilter',
        filter: { minLevel: 'WARN' }
      });
      send(bus, { type: 'customLogsFilter', value: { minLevel: 'WARN' } });

      inFilters(() => {
        fireEvent.change(filterSelect('Time'), { target: { value: '24h' } });
        fireEvent.change(filterSelect('Logged by'), { target: { value: 'ana@acme.com' } });
      });

      expect(posts(posted, 'customLogsSetFilter').map(message => message.filter)).toEqual([
        { minLevel: 'WARN' },
        { minLevel: 'WARN', since: '24h' },
        { minLevel: 'WARN', since: '24h', user: 'ana@acme.com' }
      ]);
      expect(filtersButton()).toHaveTextContent('Filters3');
    });

    it('clears one filter by picking Any, and every filter with Clear', () => {
      const { bus, posted } = mountApp();
      send(bus, { type: 'customLogsFilter', value: { minLevel: 'ERROR', since: '7d' } });
      expect(screen.getByTestId('custom-logs-filters-count')).toHaveTextContent('2');

      inFilters(() => {
        fireEvent.change(filterSelect('Time'), { target: { value: '' } });
        expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
          type: 'customLogsSetFilter',
          filter: { minLevel: 'ERROR' }
        });

        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      });

      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({ type: 'customLogsSetFilter', filter: {} });
      expect(screen.queryByTestId('custom-logs-filters-count')).toBeNull();
    });

    it('cannot clear when no filter is set', () => {
      mountApp();

      inFilters(() => {
        expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled();
      });
    });

    it('shows the filter the host replays, a time or user set elsewhere included', () => {
      const { bus } = mountApp({ rows: usersRows });

      send(bus, {
        type: 'customLogsFilter',
        value: { minLevel: 'ERROR', user: 'dev@acme.com', since: '2026-10-29T12:00:00Z' }
      });

      inFilters(() => {
        expect(filterSelect('Level')).toHaveValue('ERROR');
        expect(filterSelect('Logged by')).toHaveValue('dev@acme.com');
        expect(filterOptions('Logged by')).toEqual(['Anyone', 'dev@acme.com', 'ana@acme.com', 'zoe@acme.com']);
        expect(filterSelect('Time')).toHaveValue('2026-10-29T12:00:00Z');
        expect(filterOptions('Time')).toEqual([
          'Any time',
          '2026-10-29T12:00:00Z',
          'Last hour',
          'Last 24 hours',
          'Last 7 days'
        ]);
      });
      expect(filtersButton()).toHaveTextContent('Filters3');
    });

    it('offers only Time when the source cannot filter by level or user', () => {
      mountApp({ sources: [auditLog] });

      inFilters(() => {
        expect(screen.queryByLabelText('Level')).toBeNull();
        expect(screen.queryByLabelText('Logged by')).toBeNull();
        expect(filterOptions('Time')).toEqual(['Any time', 'Last hour', 'Last 24 hours', 'Last 7 days']);
      });
    });

    it('offers what the listed entries can be filtered by, not what their transactions can', () => {
      mountApp({
        sources: [{ ...nebula, entryCapabilities: { levelFilter: false, userFilter: true } }],
        selected: 'nebula'
      });

      inFilters(() => {
        expect(screen.queryByLabelText('Level')).toBeNull();
        expect(screen.getByLabelText('Logged by')).toBeInTheDocument();
      });
    });

    it('leaves the search alone', () => {
      const { posted } = mountApp();
      search('ORD-1043');

      inFilters(() => {
        fireEvent.change(filterSelect('Level'), { target: { value: 'ERROR' } });
      });

      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
        type: 'customLogsSetFilter',
        filter: { minLevel: 'ERROR' }
      });
      expect(searchInput()).toHaveValue('ORD-1043');
    });
  });
});
