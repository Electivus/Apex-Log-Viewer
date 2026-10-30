import { fireEvent, screen, within } from '@testing-library/react';

import {
  appLog,
  chipSummary,
  columnHeader,
  filterInput,
  grid,
  headerLabels,
  ids,
  lastPost,
  listedTitles,
  makeRow,
  mountApp,
  nebula,
  parsed,
  posts,
  rowOf,
  rows,
  send
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

const sortButton = (columnName: string) => within(columnHeader(columnName)).getAllByRole('button')[0]!;
const cellText = (id: string, columnIndex: number) =>
  rowOf(id).querySelectorAll('[role="gridcell"]')[columnIndex]?.textContent?.trim();

describe('Custom Logs JSON columns', () => {
  describe('which columns show', () => {
    it('shows the columns from the project mapping first, then the ones this workspace added', () => {
      mountApp({ defaults: ['orderId'], added: ['http.status', 'tags[]'] });

      expect(headerLabels()).toEqual([
        'Time',
        'Level',
        'Title',
        'User',
        'Category',
        'orderId',
        'http.status',
        'tags[]'
      ]);
      expect(cellText(ids.failed, 5)).toBe('ORD-1042');
      expect(cellText(ids.failed, 6)).toBe('502');
      expect(cellText(ids.failed, 7)).toBe('vip, beta');
      expect(cellText(ids.ok, 7)).toBe('—');
    });

    it('restores the added columns the host replays after a remount', () => {
      const { bus } = mountApp();

      send(bus, { type: 'customLogsPayloadColumns', value: { defaults: [], added: ['http.status'] } });

      expect(headerLabels()).toContain('http.status');
    });

    it('adds a column from the + Field picker and posts the added paths', () => {
      const { posted } = mountApp({ added: ['orderId'] });

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /http\.status/ }));

      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: ['orderId', 'http.status']
      });
      expect(headerLabels()).toEqual(['Time', 'Level', 'Title', 'User', 'Category', 'orderId', 'http.status']);
    });

    it('searches the discovered paths in the picker', () => {
      mountApp();

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'http' } });

      expect(screen.getAllByRole('menuitemcheckbox').map(item => item.querySelector('.truncate')?.textContent)).toEqual(
        ['http.status', 'http.body']
      );
      expect(screen.getByText('From payload · 2 of 5')).toBeInTheDocument();
    });

    it('removes an added column and posts the remaining ones', () => {
      const { posted } = mountApp({ added: ['orderId', 'http.status'] });

      fireEvent.click(screen.getByRole('button', { name: 'Column menu for orderId' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove column' }));

      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: ['http.status']
      });
      expect(headerLabels()).not.toContain('orderId');
    });

    it('only hides a column pinned by the project, without posting, and brings it back from the picker', () => {
      const { posted } = mountApp({ defaults: ['orderId'] });

      fireEvent.click(screen.getByRole('button', { name: 'Column menu for orderId' }));
      expect(screen.queryByRole('menuitem', { name: 'Remove column' })).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Hide column' }));

      expect(headerLabels()).not.toContain('orderId');
      expect(posts(posted, 'customLogsSetPayloadColumns')).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /orderId/ }));

      expect(headerLabels()).toContain('orderId');
      expect(posts(posted, 'customLogsSetPayloadColumns')).toEqual([]);
    });

    it('does not let the picker uncheck a column the project pins', () => {
      mountApp({ defaults: ['orderId'] });

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));

      expect(screen.getByRole('menuitemcheckbox', { name: /orderId/ })).toBeDisabled();
    });
  });

  describe('sorting loaded rows', () => {
    it('sorts a JSON column numerically, with mixed types, rows without a value last, then reverses and clears', () => {
      mountApp({ added: ['http.status'] });
      const withoutValue = ['Broken json payload', 'Free text payload', 'Empty payload', 'Hidden payload'];

      fireEvent.click(sortButton('http.status'));
      expect(listedTitles()).toEqual([
        'Order synced',
        'Retrying order sync',
        'Legacy status as text',
        'Order sync failed',
        ...withoutValue
      ]);

      fireEvent.click(sortButton('http.status'));
      expect(listedTitles()).toEqual([
        'Order sync failed',
        'Legacy status as text',
        'Retrying order sync',
        'Order synced',
        ...withoutValue
      ]);

      fireEvent.click(sortButton('http.status'));
      expect(listedTitles()).toEqual(rows.map(row => row.title));
    });

    it('sorts from the column menu', () => {
      mountApp({ added: ['http.status'] });

      fireEvent.click(screen.getByRole('button', { name: 'Column menu for http.status' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sort descending' }));

      expect(listedTitles().slice(0, 2)).toEqual(['Order sync failed', 'Legacy status as text']);
      expect(columnHeader('http.status')).toHaveAttribute('aria-sort', 'descending');
    });

    it('sorts by a fixed column', () => {
      mountApp();

      fireEvent.click(sortButton('Level'));

      expect(listedTitles()[0]).toBe('Order synced');
      fireEvent.click(sortButton('Level'));
      expect(listedTitles()[0]).toBe('Order sync failed');
    });

    it('moves the filter bar to the field when the menu asks to filter by it', () => {
      mountApp({ added: ['http.status'] });

      fireEvent.click(screen.getByRole('button', { name: 'Column menu for http.status' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Filter by this field…' }));

      expect(filterInput()).toHaveValue('http.status ');
      expect(screen.getAllByRole('option').map(option => option.textContent)).toContain('>=');
    });
  });

  describe('payloads that are not JSON objects', () => {
    it('keeps the list intact and marks each state in the first JSON column', () => {
      mountApp({ defaults: ['orderId'] });

      expect(listedTitles()).toHaveLength(rows.length);
      expect(cellText(ids.invalid, 5)).toBe('invalid JSON');
      expect(cellText(ids.text, 5)).toBe('plain text');
      expect(cellText(ids.empty, 5)).toBe('empty');
      expect(cellText(ids.hidden, 5)).toBe('hidden');
      expect(cellText(ids.ok, 5)).toBe('ORD-1043');
    });

    it('does not repeat the marker in later JSON columns', () => {
      mountApp({ defaults: ['orderId', 'http.status'] });

      expect(cellText(ids.invalid, 5)).toBe('invalid JSON');
      expect(cellText(ids.invalid, 6)).toBe('—');
    });

    it('flags the title of a row whose payload is invalid, plain text or hidden, but not an empty one', () => {
      mountApp();

      expect(within(rowOf(ids.invalid)).getByLabelText('invalid JSON')).toBeInTheDocument();
      expect(within(rowOf(ids.text)).getByLabelText('plain text')).toBeInTheDocument();
      expect(within(rowOf(ids.hidden)).getByLabelText('hidden')).toBeInTheDocument();
      expect(within(rowOf(ids.empty)).queryByLabelText('empty')).toBeNull();
      expect(within(rowOf(ids.ok)).queryByLabelText('invalid JSON')).toBeNull();
    });

    it('counts them in the status bar and says they are skipped only while a JSON filter is active', () => {
      mountApp();

      expect(screen.getByRole('status')).toHaveTextContent('1 invalid JSON · 1 plain text · 1 empty · 1 hidden');
      expect(screen.getByRole('status')).not.toHaveTextContent('skipped');
    });

    it('explains each state in the row detail', () => {
      mountApp();

      fireEvent.click(rowOf(ids.invalid));
      expect(within(screen.getByTestId('custom-log-row-detail')).getByText(/not valid JSON/)).toBeInTheDocument();
      fireEvent.click(rowOf(ids.text));
      expect(within(screen.getByTestId('custom-log-row-detail')).getByText(/plain text, not JSON/)).toBeInTheDocument();
      fireEvent.click(rowOf(ids.empty));
      expect(
        within(screen.getByTestId('custom-log-row-detail')).getByText('The payload is empty for this record.')
      ).toBeInTheDocument();
      fireEvent.click(rowOf(ids.hidden));
      expect(
        within(screen.getByTestId('custom-log-row-detail')).getByText(/permissions hide the payload/)
      ).toBeInTheDocument();
    });

    it('lets the user open the full text of an invalid or plain text payload, but not an empty or hidden one', () => {
      const { posted } = mountApp();

      fireEvent.click(rowOf(ids.invalid));
      fireEvent.click(screen.getByRole('button', { name: 'Open full payload' }));
      expect(lastPost(posted, 'customLogsOpenPayload')).toEqual({ type: 'customLogsOpenPayload', logId: ids.invalid });

      fireEvent.click(rowOf(ids.text));
      expect(screen.getByRole('button', { name: 'Open full payload' })).toBeInTheDocument();

      fireEvent.click(rowOf(ids.empty));
      expect(screen.queryByRole('button', { name: 'Open full payload' })).toBeNull();
      fireEvent.click(rowOf(ids.hidden));
      expect(screen.queryByRole('button', { name: 'Open full payload' })).toBeNull();
    });
  });

  describe('row detail', () => {
    const detail = () => screen.getByTestId('custom-log-row-detail');
    const leaf = (path: string) => within(detail()).getByTestId(`payload-leaf-${path}`);

    it('shows the selected row payload as a key/value tree', () => {
      mountApp();

      fireEvent.click(rowOf(ids.failed));

      expect(within(detail()).getByText('Order sync failed')).toBeInTheDocument();
      expect(leaf('orderId')).toHaveTextContent('orderId:"ORD-1042"');
      expect(leaf('http.status')).toHaveTextContent('status:502');
      expect(leaf('tags[1]')).toHaveTextContent('[1]:"beta"');
    });

    it('adds a leaf as a column with + Column, and shows it as added', () => {
      const { posted } = mountApp();
      fireEvent.click(rowOf(ids.failed));

      fireEvent.click(within(leaf('http.status')).getByRole('button', { name: '+ Column' }));

      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: ['http.status']
      });
      expect(within(leaf('http.status')).getByRole('button', { name: '✓ Column' })).toBeInTheDocument();
      expect(headerLabels()).toContain('http.status');

      fireEvent.click(within(leaf('http.status')).getByRole('button', { name: '✓ Column' }));
      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: []
      });
    });

    it('filters on a leaf value with = value, narrowing only the loaded rows', () => {
      const { posted } = mountApp();
      fireEvent.click(rowOf(ids.failed));

      fireEvent.click(within(leaf('orderId')).getByRole('button', { name: '= value' }));

      expect(chipSummary()).toEqual([['loaded', 'orderId=ORD-1042']]);
      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);
      expect(posts(posted, 'customLogsSetFilter')).toEqual([]);
    });

    it('uses the bracketed path for array elements, so a filter matches any element', () => {
      const { posted } = mountApp();
      fireEvent.click(rowOf(ids.failed));

      fireEvent.click(within(leaf('tags[1]')).getByRole('button', { name: '= value' }));
      expect(chipSummary()).toEqual([['loaded', 'tags[]=beta']]);
      expect(listedTitles()).toEqual(['Order sync failed', 'Retrying order sync']);

      fireEvent.click(within(leaf('lines[0].sku')).getByRole('button', { name: '+ Column' }));
      expect(lastPost(posted, 'customLogsSetPayloadColumns')).toEqual({
        type: 'customLogsSetPayloadColumns',
        added: ['lines[].sku']
      });
    });

    it('quotes a filter value that needs it', () => {
      mountApp();
      fireEvent.click(rowOf(ids.failed));

      fireEvent.click(within(leaf('http.body')).getByRole('button', { name: '= value' }));

      expect(chipSummary()).toEqual([['loaded', 'http.body="Bad gateway"']]);
      expect(listedTitles()).toEqual(['Order sync failed']);
    });

    it('does not offer to remove a column the project pins', () => {
      mountApp({ defaults: ['orderId'] });
      fireEvent.click(rowOf(ids.failed));

      expect(within(leaf('orderId')).getByRole('button', { name: '✓ Column' })).toBeDisabled();
      expect(within(leaf('http.status')).getByRole('button', { name: '+ Column' })).toBeEnabled();
    });

    it('says when paths or values were cut', () => {
      const cut = makeRow('a0B5g00000Zt1Q9EAJ', 'Huge payload', {
        payload: parsed({ a: 'x' }, { droppedPaths: 12, cutValues: ['a'] })
      });
      mountApp({ rows: [cut] });

      fireEvent.click(rowOf(cut.id));

      expect(
        within(detail()).getByText('12 more paths are not shown. Open the full payload to read them.')
      ).toBeInTheDocument();
      expect(within(leaf('a')).getByText('(cut)')).toBeInTheDocument();
    });

    it('opens the log from the detail, a double click or Enter', () => {
      const { posted } = mountApp();

      fireEvent.click(rowOf(ids.failed));
      fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
      fireEvent.doubleClick(rowOf(ids.retry));
      fireEvent.keyDown(grid(), { key: 'Enter' });

      expect(posts(posted, 'customLogsOpenLog')).toEqual([
        { type: 'customLogsOpenLog', logId: ids.failed },
        { type: 'customLogsOpenLog', logId: ids.retry },
        { type: 'customLogsOpenLog', logId: ids.failed }
      ]);
    });

    it('moves the selection with the arrow keys and closes with the close button', () => {
      mountApp();

      fireEvent.keyDown(grid(), { key: 'ArrowDown' });
      expect(within(detail()).getByText('Order sync failed')).toBeInTheDocument();
      fireEvent.keyDown(grid(), { key: 'ArrowDown' });
      expect(within(detail()).getByText('Retrying order sync')).toBeInTheDocument();
      fireEvent.keyDown(grid(), { key: 'ArrowUp' });
      expect(within(detail()).getByText('Order sync failed')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
      expect(screen.queryByTestId('custom-log-row-detail')).toBeNull();
    });

    it('closes the detail when the filters hide the selected row', () => {
      mountApp();
      fireEvent.click(rowOf(ids.failed));

      fireEvent.change(filterInput(), { target: { value: 'orderId = ORD-1043' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(screen.queryByTestId('custom-log-row-detail')).toBeNull();
    });
  });

  describe('when there is nothing to list', () => {
    it('says no source is ready, lists why and the mapping issues, and opens the config', () => {
      const { posted } = mountApp({
        sources: [
          { ...nebula, state: 'notInstalled' },
          {
            ...appLog,
            state: 'unavailable',
            reason: 'requiredFieldMissing',
            message: 'Message__c is missing or hidden'
          }
        ],
        selected: 'nebula',
        issues: [
          {
            severity: 'error',
            pointer: '/plugins/electivus/customLogs/sources/0/entry/fields/time',
            message: 'Missing required key'
          },
          {
            severity: 'warning',
            pointer: '/plugins/electivus/customLogs/sources/0/entry/colums',
            message: 'Unknown key'
          }
        ]
      });

      expect(screen.getByText('No custom log source is ready in this org.')).toBeInTheDocument();
      expect(screen.getByText('Nebula Logger is not installed in this org.')).toBeInTheDocument();
      expect(screen.getByText('App Log is unavailable: Message__c is missing or hidden')).toBeInTheDocument();
      expect(screen.getByText(/Missing required key/)).toBeInTheDocument();
      expect(screen.getByText(/Unknown key/)).toBeInTheDocument();
      expect(screen.queryByRole('grid')).toBeNull();

      fireEvent.click(within(screen.getByTestId('custom-logs-empty')).getByRole('button', { name: 'Configure' }));
      expect(posts(posted, 'customLogsOpenConfig')).toHaveLength(1);
    });

    it('tells a Log__c collision from a missing install', () => {
      mountApp({ sources: [{ ...nebula, state: 'notInstalled', hint: 'collision' }], selected: 'nebula' });

      expect(
        screen.getByText('Nebula Logger: this org has a Log__c that is not Nebula Logger. Map it in sfdx-project.json.')
      ).toBeInTheDocument();
    });

    it('says there are no logs when the source is ready but empty', () => {
      mountApp({ rows: [], fields: [] });

      expect(screen.getByText('No logs found for this source and these filters.')).toBeInTheDocument();
    });
  });

  describe('toolbar and banners', () => {
    it('refreshes, configures and opens the editor tab from the toolbar', () => {
      const { posted } = mountApp();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));

      expect(posted.slice(1).map(message => message.type)).toEqual([
        'customLogsRefresh',
        'customLogsOpenConfig',
        'customLogsOpenEditor'
      ]);
    });

    it('hides Open in editor in the editor tab itself', () => {
      mountApp({ surface: 'editor' });

      expect(screen.queryByRole('button', { name: 'Open in editor' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    });

    it('shows the error the host reports and clears it', () => {
      const { bus } = mountApp();

      send(bus, { type: 'customLogsError', message: 'INVALID_FIELD on Message__c' });
      expect(screen.getByRole('alert')).toHaveTextContent('INVALID_FIELD on Message__c');

      send(bus, { type: 'customLogsError' });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the rows on screen while a refresh loads', () => {
      const { bus } = mountApp();

      send(bus, { type: 'customLogsLoading', value: true });

      expect(listedTitles()).toHaveLength(rows.length);
      expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();
    });
  });
});
