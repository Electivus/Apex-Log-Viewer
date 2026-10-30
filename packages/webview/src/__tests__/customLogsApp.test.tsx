import { fireEvent, screen } from '@testing-library/react';

import {
  appLog,
  chipSummary,
  chips,
  filterInput,
  headerLabels,
  ids,
  lastPost,
  listedTitles,
  makeRow,
  mountApp,
  nebula,
  parsed,
  posts,
  removeMountSequenceMeta,
  rows,
  send,
  submit
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
      if (listRef && 'current' in listRef) {
        (listRef as { current: unknown }).current = api;
      }
      return React.createElement('div', { 'data-testid': 'virtual-list', style, className }, items);
    }
  };
});

afterEach(removeMountSequenceMeta);

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
      expect(screen.getByRole('combobox', { name: 'Filtrar logs' })).toBeInTheDocument();
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

  describe('server-side filter chips', () => {
    it('posts the minimum level, shows a Salesforce chip and lets the host reset paging', () => {
      const { posted, bus } = mountApp();

      submit('level >= warn');

      expect(posts(posted, 'customLogsSetFilter')).toEqual([
        { type: 'customLogsSetFilter', filter: { minLevel: 'WARN' } }
      ]);
      expect(chipSummary()).toEqual([['server', 'level>=WARN']]);
      expect(listedTitles()).toHaveLength(rows.length);

      send(bus, { type: 'customLogsFilter', value: { minLevel: 'WARN' } });
      send(bus, {
        type: 'customLogsPage',
        mode: 'replace',
        columns: [],
        rows: [rows[0]!, rows[1]!],
        payloadFields: [],
        hasMore: false
      });
      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);
    });

    it('sends the whole server filter each time, user and since included', () => {
      const { posted } = mountApp();

      submit('level >= ERROR');
      submit('user = dev@acme.com');
      submit('since = 24h');

      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
        type: 'customLogsSetFilter',
        filter: { minLevel: 'ERROR', user: 'dev@acme.com', since: '24h' }
      });
      expect(chipSummary().map(([, text]) => text)).toEqual(['level>=ERROR', 'user=dev@acme.com', 'since=24h']);
    });

    it('applies several server conditions typed together as one query change', () => {
      const { posted } = mountApp();

      submit('level >= WARN and since = 7d');

      expect(posts(posted, 'customLogsSetFilter')).toEqual([
        { type: 'customLogsSetFilter', filter: { minLevel: 'WARN', since: '7d' } }
      ]);
    });

    it('removes a server chip by posting the filter without it', () => {
      const { posted, bus } = mountApp();
      send(bus, { type: 'customLogsFilter', value: { minLevel: 'WARN', since: '24h' } });

      fireEvent.click(screen.getByRole('button', { name: 'Remove filter level >= WARN' }));

      expect(lastPost(posted, 'customLogsSetFilter')).toEqual({
        type: 'customLogsSetFilter',
        filter: { since: '24h' }
      });
    });

    it('shows the filter the host replays after a remount', () => {
      const { bus } = mountApp();

      send(bus, { type: 'customLogsFilter', value: { minLevel: 'ERROR', user: 'dev@acme.com' } });

      expect(chipSummary()).toEqual([
        ['server', 'level>=ERROR'],
        ['server', 'user=dev@acme.com']
      ]);
    });

    it('names the problem and its position when a server filter is wrong, and posts nothing', () => {
      const { posted } = mountApp();

      submit('level >= LOUD');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Use one of FINEST, FINER, FINE, DEBUG, INFO, WARN or ERROR (col 10)'
      );

      submit('level = ERROR');
      expect(screen.getByRole('alert')).toHaveTextContent('level only supports >= (col 7)');

      submit('since = yesterday');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Use a duration such as 30m, 24h or 7d, or an ISO date with an offset such as 2026-10-29T12:00:00Z (col 9)'
      );

      submit('since = 2026-10-29T10:00');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Use a duration such as 30m, 24h or 7d, or an ISO date with an offset such as 2026-10-29T12:00:00Z (col 9)'
      );

      expect(posts(posted, 'customLogsSetFilter')).toEqual([]);
      expect(chips()).toHaveLength(0);
    });

    it('does not offer level or user when the source cannot filter by them', () => {
      mountApp({
        sources: [{ ...appLog, capabilities: { levelFilter: false, userFilter: false, apexLogLink: false } }]
      });

      fireEvent.focus(filterInput());
      const options = screen.getAllByRole('option').map(option => option.textContent ?? '');

      expect(options.some(text => text.startsWith('level'))).toBe(false);
      expect(options.some(text => text.startsWith('user'))).toBe(false);
      expect(options.some(text => text.startsWith('since'))).toBe(true);

      submit('level >= WARN');
      expect(screen.getByRole('alert')).toHaveTextContent('This source cannot filter by level');
    });

    it('switches source from the filter row, and shows the source as a Salesforce chip when there is a choice', () => {
      const { posted } = mountApp({ sources: [appLog, nebula], selected: 'app-log' });

      expect(chipSummary()).toEqual([['server', 'source=app-log']]);
      expect(screen.getByTestId('custom-logs-source')).toBeInTheDocument();

      submit('source = nebula');
      expect(lastPost(posted, 'customLogsSelectSource')).toEqual({
        type: 'customLogsSelectSource',
        sourceId: 'nebula'
      });

      submit('source = nope');
      expect(screen.getByRole('alert')).toHaveTextContent('Unknown source');
    });

    it('hides the source picker when only one source is ready', () => {
      mountApp();

      expect(screen.queryByTestId('custom-logs-source')).toBeNull();
      expect(chips()).toHaveLength(0);
    });
  });

  describe('loaded-row filters over JSON payload paths', () => {
    it('narrows the loaded rows without asking Salesforce, and says so in the status bar', () => {
      const { posted } = mountApp();

      submit('http.status >= 500');

      expect(chipSummary()).toEqual([['loaded', 'http.status>=500']]);
      expect(listedTitles()).toEqual(['Order sync failed', 'Legacy status as text']);
      expect(posts(posted, 'customLogsSetFilter')).toEqual([]);
      expect(screen.getByRole('status')).toHaveTextContent('Filtering 8 loaded rows · 2 match');
      expect(screen.getByRole('status')).toHaveTextContent(
        '1 invalid JSON · 1 plain text · 1 empty · 1 hidden: skipped by JSON filters'
      );
    });

    it('combines conditions with and, and matches any element of an array', () => {
      mountApp();

      submit('tags[] = "beta" and orderId = ORD-1042');
      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);

      submit('tags[] = "vip"');
      expect(listedTitles()).toEqual(['Order sync failed']);
      expect(chipSummary().map(([, text]) => text)).toEqual(['tags[]=beta', 'orderId=ORD-1042', 'tags[]=vip']);
    });

    it('explains that or is not supported, with the position, and keeps the filters it had', () => {
      mountApp();
      submit('orderId = ORD-1042');

      submit('http.status = 200 or http.status = 500');

      expect(screen.getByRole('alert')).toHaveTextContent(
        '"or" is not supported yet: conditions combine with "and" only (col 19)'
      );
      expect(chips()).toHaveLength(1);
    });

    it('reports syntax errors at the character that breaks them', () => {
      mountApp();

      submit('nofield');
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Expected an operator after "nofield": = != > >= < <= contains exists (col 8)'
      );

      submit('nofield = >= 5');
      expect(screen.getByRole('alert')).toHaveTextContent('Expected a value after the operator (col 11)');

      submit('message = "open');
      expect(screen.getByRole('alert')).toHaveTextContent('This string is not closed (col 11)');

      submit('a = 1 and');
      expect(screen.getByRole('alert')).toHaveTextContent('Expected another condition after "and" (col 10)');
    });

    it('removes a chip and restores the rows', () => {
      mountApp();
      submit('orderId = ORD-1043');
      expect(listedTitles()).toEqual(['Order synced']);

      fireEvent.click(screen.getByRole('button', { name: 'Remove filter orderId = ORD-1043' }));

      expect(listedTitles()).toHaveLength(rows.length);
    });

    it('turns a chip back into text to edit', () => {
      mountApp();
      submit('http.status >= 500');

      fireEvent.click(screen.getByRole('button', { name: 'Edit filter http.status >= 500' }));

      expect(chips()).toHaveLength(0);
      expect(filterInput()).toHaveValue('http.status >= 500');
      expect(listedTitles()).toHaveLength(rows.length);
    });

    it('tells the user when no loaded row matches, and that Load more may widen it', () => {
      mountApp({ hasMore: true });

      submit('orderId = nothing');

      expect(
        screen.getByText('No loaded row matches. Only 8 rows are loaded. Use Load more to widen the search.')
      ).toBeInTheDocument();
    });

    it('keeps the filters when the app is restored from its saved state', () => {
      const first = mountApp();
      submit('orderId = ORD-1043');
      const saved = first.getSavedState();
      first.view.unmount();

      mountApp({}, saved);

      expect(chipSummary()).toEqual([['loaded', 'orderId=ORD-1043']]);
      expect(listedTitles()).toEqual(['Order synced']);
    });

    it('drops the filters when the source changes', () => {
      const { bus } = mountApp({ sources: [appLog, nebula], selected: 'app-log' });
      submit('orderId = ORD-1043');
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

      expect(chipSummary()).toEqual([['server', 'source=nebula']]);
      expect(listedTitles()).toEqual(['Log-000739']);
    });

    it('keeps the JSON filters typed together with a source change, and drops the ones the previous source had', () => {
      const { bus, posted } = mountApp({
        sources: [appLog, nebula],
        selected: 'nebula',
        rows: [makeRow('a015g00000Q2xYzAAB', 'Log-000739', { payload: parsed({ orderId: 'ORD-1043' }) })]
      });
      submit('orderId = ORD-1043');

      submit('source = app-log and http.status >= 500');
      expect(lastPost(posted, 'customLogsSelectSource')).toEqual({
        type: 'customLogsSelectSource',
        sourceId: 'app-log'
      });
      send(bus, { type: 'customLogsLoading', value: true });
      send(bus, { type: 'customLogsPage', mode: 'replace', columns: [], rows: [], payloadFields: [], hasMore: false });
      send(bus, { type: 'customLogsSources', data: [appLog, nebula], selected: 'app-log', issues: [] });
      send(bus, { type: 'customLogsFilter', value: {} });
      send(bus, { type: 'customLogsPayloadColumns', value: { defaults: [], added: [] } });
      send(bus, { type: 'customLogsPage', mode: 'replace', columns: [], rows, payloadFields: [], hasMore: false });
      send(bus, { type: 'customLogsLoading', value: false });

      expect(chipSummary()).toEqual([
        ['server', 'source=app-log'],
        ['loaded', 'http.status>=500']
      ]);
      expect(listedTitles()).toEqual(['Order sync failed', 'Legacy status as text']);
    });
  });

  describe('autocomplete', () => {
    it('lists server fields first, then payload paths with their type and share of loaded rows', () => {
      mountApp();

      fireEvent.focus(filterInput());
      const options = screen.getAllByRole('option').map(option => option.textContent);

      expect(options).toEqual([
        'levelSalesforce',
        'userSalesforce',
        'sinceSalesforce',
        'http.statusmixed50%',
        'orderIdstr50%',
        'tags[]str25%',
        'http.bodystr13%',
        'lines[].skustr13%'
      ]);
    });

    it('walks field, operator and value', () => {
      mountApp();

      fireEvent.change(filterInput(), { target: { value: 'http.st' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });
      expect(filterInput()).toHaveValue('http.status ');
      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
        '=',
        '!=',
        '>',
        '>=',
        '<',
        '<=',
        'contains',
        'exists'
      ]);

      fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
      fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
      fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });
      expect(filterInput()).toHaveValue('http.status >= ');
    });

    it('offers the top values among loaded rows with their counts', () => {
      mountApp();

      fireEvent.change(filterInput(), { target: { value: 'orderId = ' } });

      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
        'ORD-10422 rows',
        'ORD-10431 row',
        'ORD-10441 row'
      ]);
    });

    it('commits the highlighted value on Enter', () => {
      mountApp();
      fireEvent.change(filterInput(), { target: { value: 'orderId = ' } });

      fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(chipSummary()).toEqual([['loaded', 'orderId=ORD-1042']]);
      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);
    });

    it('offers the since quick values', () => {
      mountApp();

      fireEvent.change(filterInput(), { target: { value: 'since = ' } });

      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['1h', '24h', '7d']);
    });

    it('adds the field as a column with Shift+Enter', () => {
      const { posted } = mountApp();

      fireEvent.change(filterInput(), { target: { value: 'http.bo' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter', shiftKey: true });

      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: ['http.body']
      });
      expect(headerLabels()).toContain('http.body');
    });

    it('lists a path that only the second page carries', () => {
      const { bus } = mountApp();
      send(bus, {
        type: 'customLogsPage',
        mode: 'append',
        columns: [{ key: 'Category__c', label: 'Category' }],
        rows: [makeRow('a0B5g00000Zt1Q1EAJ', 'Second page row', { payload: parsed({ region: 'us-east' }) })],
        payloadFields: [{ path: 'region', types: ['string'], rows: 1 }],
        hasMore: false
      });

      fireEvent.change(filterInput(), { target: { value: 'regi' } });

      expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['regionstr11%']);
      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));
      expect(screen.getByRole('menuitemcheckbox', { name: /region/ })).toBeInTheDocument();
    });
  });
});
