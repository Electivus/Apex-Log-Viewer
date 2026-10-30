import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type {
  CustomLogViewerFromWebviewMessage,
  CustomLogViewerToWebviewMessage
} from '@alv/protocol/customLogViewerMessages';
import type {
  CustomLogApexLogLink,
  CustomLogEntry,
  CustomLogLongFieldView,
  CustomLogPayloadField,
  CustomLogPayloadView,
  CustomLogRow,
  CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { CustomLogViewerApp } from '../customLogViewer';

jest.mock('react-window', () => {
  const React = require('react');
  return {
    List: ({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) => {
      const items = Array.from({ length: rowCount }).map((_: unknown, index: number) =>
        React.createElement(rowComponent, {
          key: index,
          ...rowProps,
          index,
          style: { height: typeof rowHeight === 'function' ? rowHeight(index) : rowHeight }
        })
      );
      const api = { element: null, scrollToRow: () => {} };
      if (listRef && 'current' in listRef) {
        (listRef as { current: unknown }).current = api;
      }
      return React.createElement('div', { 'data-testid': 'virtual-list', style, className }, items);
    }
  };
});

const logId = 'a015g00000Q2xYzAAB';
const entryIds = {
  start: 'a025g00000Hk1AbAAJ',
  system: 'a025g00000Hk1AcAAJ',
  error: 'a025g00000Hk1BxAAJ',
  warn: 'a025g00000Hk1ByAAJ',
  debug: 'a025g00000Hk1BzAAJ',
  payload: 'a025g00000Hk1C0AAJ',
  invalid: 'a025g00000Hk1C1AAJ',
  text: 'a025g00000Hk1C2AAJ'
};

function parsed(values: Record<string, CustomLogScalar>): CustomLogPayloadView {
  return { state: 'parsed', values, droppedPaths: 0, cutValues: [] };
}

function makeEntry(
  id: string,
  sequence: number,
  message: string,
  overrides: Partial<CustomLogEntry> = {}
): CustomLogEntry {
  return {
    id,
    sequence,
    time: `2026-10-29T23:29:49.${String(700 + sequence).padStart(3, '0')}Z`,
    level: 'INFO',
    rawLevel: 'INFO',
    message,
    previewClipped: false,
    system: false,
    presentDetails: [],
    extra: { OriginType__c: 'Apex' },
    ...overrides
  };
}

const log: CustomLogRow = {
  id: logId,
  time: '2026-10-29T23:29:49.000Z',
  title: 'Log-000739',
  user: 'dev@acme.com',
  level: 'ERROR',
  counts: { entries: 33, errors: 1, warnings: 1 },
  transactionId: 'ae12d024-5b1c-4f0e-9d5e-1b8c0d1f2a77',
  requestId: 'SLB:4a900e268688662da18e15251e53b946',
  extra: {}
};

const entries: CustomLogEntry[] = [
  makeEntry(entryIds.start, 1, 'Starting order sync', { origin: 'OrderSync.run', presentDetails: ['StackTrace__c'] }),
  makeEntry(entryIds.system, 2, 'Nebula Logger - Saving 2 log entries via ANONYMOUS', {
    level: 'FINEST',
    rawLevel: 'FINEST',
    system: true
  }),
  makeEntry(entryIds.error, 3, 'Divide by 0', {
    level: 'ERROR',
    rawLevel: 'ERROR',
    origin: 'OrderSync.run',
    exceptionType: 'System.MathException',
    presentDetails: ['ExceptionStackTrace__c', 'StackTrace__c', 'RecordJson__c']
  }),
  makeEntry(entryIds.warn, 4, 'Retrying after timeout', { level: 'WARN', rawLevel: 'WARN', origin: 'HttpClient.send' }),
  makeEntry(entryIds.debug, 5, 'Built request', { level: 'DEBUG', rawLevel: 'DEBUG', origin: 'HttpClient.send' })
];

const payloadEntries: CustomLogEntry[] = [
  makeEntry(entryIds.payload, 1, 'Order synced', {
    payload: parsed({ orderId: 'ORD-1042', 'http.status': 502, 'tags[0]': 'vip' })
  }),
  makeEntry(entryIds.invalid, 2, 'Broken payload', { payload: { state: 'invalid' } }),
  makeEntry(entryIds.text, 3, 'Text payload', { payload: { state: 'text' } })
];

const payloadFields: CustomLogPayloadField[] = [
  { path: 'orderId', types: ['string'], rows: 1 },
  { path: 'http.status', types: ['number'], rows: 1 },
  { path: 'tags[0]', types: ['string'], rows: 1 }
];

const linked: CustomLogApexLogLink = {
  state: 'linked',
  logId: '07L5g00000XyZabEAE',
  startTime: '2026-10-29T23:29:49.000Z',
  logLength: 48213
};

function createVsCodeMock(initialState?: unknown) {
  const posted: CustomLogViewerFromWebviewMessage[] = [];
  let savedState = initialState;
  const vscode: VsCodeWebviewApi<CustomLogViewerFromWebviewMessage> = {
    postMessage: msg => {
      posted.push(msg);
    },
    getState: () => savedState as any,
    setState: state => {
      savedState = state;
    }
  };
  return { vscode, posted };
}

function send(bus: EventTarget, message: CustomLogViewerToWebviewMessage) {
  act(() => {
    bus.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

type MountOptions = {
  entries?: CustomLogEntry[];
  fields?: CustomLogPayloadField[];
  apexLog?: CustomLogApexLogLink;
  logPayload?: CustomLogLongFieldView;
  defaults?: string[];
  added?: string[];
  hasMore?: boolean;
  locale?: string;
};

function mountViewer(options: MountOptions = {}) {
  const mock = createVsCodeMock();
  const bus = new EventTarget();
  const view = render(<CustomLogViewerApp vscode={mock.vscode} messageBus={bus} />);
  send(bus, {
    type: 'customLogViewerInit',
    locale: options.locale ?? 'en',
    source: { id: 'nebula-managed', label: 'Nebula Logger (managed)', shape: 'transactions' },
    log,
    logPayload: options.logPayload,
    entryColumns: [{ key: 'OriginType__c', label: 'Origin Type' }],
    payloadColumns: { defaults: options.defaults ?? [], added: options.added ?? [] },
    apexLog: options.apexLog ?? linked
  });
  send(bus, {
    type: 'customLogViewerEntries',
    mode: 'replace',
    entries: options.entries ?? entries,
    payloadFields: options.fields ?? [],
    hasMore: options.hasMore ?? false
  });
  return { ...mock, bus, view };
}

const grid = () => screen.getByRole('grid');
const rowOf = (id: string) => grid().querySelector(`[data-entry-id="${id}"]`) as HTMLElement;
const messageOf = (id: string) => rowOf(id).querySelector('.line-clamp-4')?.textContent?.replace(/\s…$/, '');
const shownIds = () =>
  Array.from(grid().querySelectorAll('[data-entry-id]')).map(row => row.getAttribute('data-entry-id'));
const levelGroup = () => screen.getByRole('group', { name: 'Filter by level' });
const detailGroup = () => screen.getByRole('group', { name: 'Filter by long field' });
const posts = <T extends CustomLogViewerFromWebviewMessage['type']>(
  posted: CustomLogViewerFromWebviewMessage[],
  type: T
) =>
  posted.filter((message): message is Extract<CustomLogViewerFromWebviewMessage, { type: T }> => message.type === type);

describe('Custom Log viewer app', () => {
  describe('header', () => {
    it('announces itself, then shows the log the host sends', () => {
      const { posted } = mountViewer();

      expect(posted).toEqual([{ type: 'customLogViewerReady' }]);
      expect(screen.getByTestId('custom-log-viewer-title')).toHaveTextContent('Log-000739');
      const header = screen.getByRole('banner');
      expect(header).toHaveTextContent('Nebula Logger (managed)');
      expect(header).toHaveTextContent('dev@acme.com');
      expect(header).toHaveTextContent('33 entries');
      expect(header).toHaveTextContent('1 errors');
      expect(header).toHaveTextContent('1 warnings');
      expect(header).toHaveTextContent('ae12d024-5b1c-4f0e-9d5e-1b8c0d1f2a77');
    });

    it('opens the Apex log without sending an id', () => {
      const { posted } = mountViewer();

      fireEvent.click(screen.getByRole('button', { name: 'Open Apex log' }));

      expect(posts(posted, 'customLogViewerOpenApexLog')).toEqual([{ type: 'customLogViewerOpenApexLog' }]);
    });

    it('explains why there is no Apex log instead of offering a dead button', () => {
      const first = mountViewer({ apexLog: { state: 'notFound' } });
      expect(screen.queryByRole('button', { name: 'Open Apex log' })).toBeNull();
      expect(screen.getByTestId('custom-log-apex-hint')).toHaveTextContent('No Apex debug log for this request');
      first.view.unmount();

      mountViewer({ apexLog: { state: 'noRequestId' } });
      expect(screen.getByTestId('custom-log-apex-hint')).toHaveTextContent('no request id');
    });

    it('copies the transaction id through the host', () => {
      const { posted } = mountViewer();

      fireEvent.click(screen.getByRole('button', { name: 'Copy Transaction' }));

      expect(posts(posted, 'customLogViewerCopyText')).toEqual([
        { type: 'customLogViewerCopyText', text: 'ae12d024-5b1c-4f0e-9d5e-1b8c0d1f2a77' }
      ]);
    });

    it('opens the header payload by key, and says when it is hidden', () => {
      const first = mountViewer({ logPayload: { key: 'payload', label: 'Payload', state: 'value', format: 'json' } });
      fireEvent.click(screen.getByRole('button', { name: 'Open JSON' }));
      expect(posts(first.posted, 'customLogViewerOpenField')).toEqual([
        { type: 'customLogViewerOpenField', target: { kind: 'logPayload' } }
      ]);
      first.view.unmount();

      mountViewer({ logPayload: { key: 'payload', label: 'Payload', state: 'hidden' } });
      expect(screen.getByRole('banner')).toHaveTextContent('hidden by your permissions');
    });

    it('refreshes from the header', () => {
      const { posted } = mountViewer();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(posts(posted, 'customLogViewerRefresh')).toHaveLength(1);
    });

    it('speaks Portuguese when the host says so', () => {
      mountViewer({ locale: 'pt-BR' });

      expect(screen.getByRole('button', { name: 'Abrir log do Apex' })).toBeInTheDocument();
      expect(screen.getByRole('searchbox', { name: 'Buscar entradas…' })).toBeInTheDocument();
    });
  });

  describe('entries', () => {
    it('hides the logger system messages until asked, and counts them in the toggle', () => {
      mountViewer();

      expect(shownIds()).toEqual([entryIds.start, entryIds.error, entryIds.warn, entryIds.debug]);
      const toggle = screen.getByRole('switch', { name: /Show logger system messages \(1\)/ });
      expect(toggle).not.toBeChecked();

      fireEvent.click(toggle);

      expect(shownIds()).toEqual([entryIds.start, entryIds.system, entryIds.error, entryIds.warn, entryIds.debug]);
      expect(screen.getByRole('status')).toHaveTextContent('5 entries loaded');
    });

    it('shows how many of the loaded entries pass the filters', () => {
      mountViewer();

      expect(screen.getByRole('status')).toHaveTextContent('4 of 5 entries shown');
    });

    it('filters by level chips, with counts, combining levels', () => {
      mountViewer();

      expect(
        within(levelGroup())
          .getAllByRole('button')
          .map(chip => chip.textContent)
      ).toEqual(['ERROR1', 'WARN1', 'INFO1', 'DEBUG1', 'FINEST1']);

      fireEvent.click(within(levelGroup()).getByRole('button', { name: /ERROR/ }));
      expect(shownIds()).toEqual([entryIds.error]);

      fireEvent.click(within(levelGroup()).getByRole('button', { name: /WARN/ }));
      expect(shownIds()).toEqual([entryIds.error, entryIds.warn]);

      fireEvent.click(within(levelGroup()).getByRole('button', { name: /ERROR/ }));
      fireEvent.click(within(levelGroup()).getByRole('button', { name: /WARN/ }));
      expect(shownIds()).toHaveLength(4);
    });

    it('filters by the long fields entries carry', () => {
      mountViewer();

      expect(
        within(detailGroup())
          .getAllByRole('button')
          .map(chip => chip.textContent)
      ).toEqual(['StackTrace2', 'ExceptionStackTrace1', 'RecordJson1']);

      fireEvent.click(within(detailGroup()).getByRole('button', { name: /^ExceptionStackTrace/ }));

      expect(shownIds()).toEqual([entryIds.error]);
    });

    it('filters by text over message, origin and exception type', () => {
      mountViewer();
      const search = screen.getByRole('searchbox', { name: 'Search entries…' });

      fireEvent.change(search, { target: { value: 'httpclient' } });
      expect(shownIds()).toEqual([entryIds.warn, entryIds.debug]);

      fireEvent.change(search, { target: { value: 'mathexception' } });
      expect(shownIds()).toEqual([entryIds.error]);

      fireEvent.change(search, { target: { value: 'divide' } });
      expect(shownIds()).toEqual([entryIds.error]);
    });

    it('says when no loaded entry matches, and when the log is empty', () => {
      const first = mountViewer({ hasMore: true });
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });
      expect(
        screen.getByText('No loaded entry matches the current filters. Use Load more entries to widen the search.')
      ).toBeInTheDocument();
      first.view.unmount();

      mountViewer({ entries: [] });
      expect(screen.getByText('This log has no entries.')).toBeInTheDocument();
    });

    it('pages: load more asks the host, append keeps the loaded entries', () => {
      const { posted, bus } = mountViewer({ hasMore: true });

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(posts(posted, 'customLogViewerLoadMoreEntries')).toHaveLength(1);

      send(bus, {
        type: 'customLogViewerEntries',
        mode: 'append',
        entries: [makeEntry('a025g00000Hk1D0AAJ', 6, 'Page two entry', { origin: 'Next.run' })],
        payloadFields: [],
        hasMore: false
      });

      expect(shownIds()).toHaveLength(5);
      expect(messageOf('a025g00000Hk1D0AAJ')).toBe('Page two entry');
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    it('shows the source display columns', () => {
      mountViewer();

      expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toContain('Origin Type');
      expect(rowOf(entryIds.start)).toHaveTextContent('Apex');
    });

    it('shows the message of an entry in full and marks a clipped one', () => {
      const clipped = makeEntry('a025g00000Hk1D1AAJ', 9, 'A very long message', { previewClipped: true });
      mountViewer({ entries: [clipped] });

      expect(rowOf(clipped.id)).toHaveTextContent('A very long message …');
    });
  });

  describe('entry detail', () => {
    const fields: CustomLogLongFieldView[] = [
      { key: 'message', label: 'Message', state: 'value', format: 'text', truncated: true },
      { key: 'StackTrace__c', label: 'Stack Trace', state: 'value', format: 'text' },
      { key: 'RecordJson__c', label: 'Record JSON', state: 'value', format: 'json' },
      { key: 'HttpRequestBody__c', label: 'HTTP Request Body', state: 'hidden' },
      { key: 'Tags__c', label: 'Tags', state: 'empty' },
      { key: 'RestRequestBody__c', label: 'REST Request Body', state: 'unmapped' },
      { key: 'payload', label: 'Payload', state: 'unmapped' }
    ];

    it('asks the host for the long fields of the selected entry, once, and lists them with their states', () => {
      const { posted, bus } = mountViewer();

      fireEvent.click(rowOf(entryIds.error));
      expect(posts(posted, 'customLogViewerOpenEntry')).toEqual([
        { type: 'customLogViewerOpenEntry', entryId: entryIds.error }
      ]);
      send(bus, { type: 'customLogViewerLoading', scope: 'entry', value: true });
      expect(screen.getByText('Loading fields…')).toBeInTheDocument();

      send(bus, { type: 'customLogViewerEntryFields', entryId: entryIds.error, fields });
      send(bus, { type: 'customLogViewerLoading', scope: 'entry', value: false });

      const detail = screen.getByTestId('custom-log-entry-detail');
      expect(within(detail).getByTestId('entry-field-message')).toHaveTextContent('truncated by the logger');
      expect(within(detail).getByTestId('entry-field-RecordJson__c')).toHaveTextContent('json');
      expect(within(detail).getByTestId('entry-field-HttpRequestBody__c')).toHaveTextContent(
        'hidden by your permissions'
      );
      expect(within(detail).getByTestId('entry-field-Tags__c')).toHaveTextContent('empty');
      expect(within(detail).queryByTestId('entry-field-RestRequestBody__c')).toBeNull();
      expect(within(detail).getByText('System.MathException')).toBeInTheDocument();

      fireEvent.click(rowOf(entryIds.warn));
      fireEvent.click(rowOf(entryIds.error));
      expect(
        posts(posted, 'customLogViewerOpenEntry').filter(message => message.entryId === entryIds.error)
      ).toHaveLength(1);
    });

    it('opens a long field by its key, never by its text', () => {
      const { posted, bus } = mountViewer();
      fireEvent.click(rowOf(entryIds.error));
      send(bus, { type: 'customLogViewerEntryFields', entryId: entryIds.error, fields });

      fireEvent.click(screen.getByRole('button', { name: 'Open Stack Trace' }));

      expect(posts(posted, 'customLogViewerOpenField')).toEqual([
        { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: entryIds.error, key: 'StackTrace__c' } }
      ]);
      expect(screen.queryByRole('button', { name: 'Open HTTP Request Body' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Open Tags' })).toBeNull();
    });

    it('copies the full message through the host and closes', () => {
      const { posted } = mountViewer();
      fireEvent.click(rowOf(entryIds.error));

      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
      expect(posts(posted, 'customLogViewerCopyText')).toEqual([
        { type: 'customLogViewerCopyText', text: 'Divide by 0' }
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Close entry' }));
      expect(screen.queryByTestId('custom-log-entry-detail')).toBeNull();
    });

    it('moves the selection with the arrow keys', () => {
      mountViewer();

      fireEvent.keyDown(grid(), { key: 'ArrowDown' });
      expect(
        within(screen.getByTestId('custom-log-entry-detail')).getByText('Starting order sync')
      ).toBeInTheDocument();
      fireEvent.keyDown(grid(), { key: 'ArrowDown' });
      expect(within(screen.getByTestId('custom-log-entry-detail')).getByText('Divide by 0')).toBeInTheDocument();
    });

    it('shows an error scoped to the entry, and clears it when the fields arrive', () => {
      const { bus } = mountViewer();
      fireEvent.click(rowOf(entryIds.error));

      send(bus, { type: 'customLogViewerError', scope: 'entry', message: 'INVALID_FIELD' });
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load the entry: INVALID_FIELD');

      send(bus, { type: 'customLogViewerEntryFields', entryId: entryIds.error, fields });
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('JSON columns on entry payloads', () => {
    it('does not show the JSON filter row for a source without payloads', () => {
      mountViewer();

      expect(screen.queryByRole('combobox', { name: 'Filter logs' })).toBeNull();
    });

    it('shows the project columns first, then the added ones, and keeps invalid and plain text payloads on the list', () => {
      mountViewer({ entries: payloadEntries, fields: payloadFields, defaults: ['orderId'], added: ['http.status'] });

      expect(
        screen
          .getAllByRole('columnheader')
          .map(header => header.querySelector('button span.truncate')?.textContent)
          .filter(Boolean)
      ).toEqual(['#', 'Time', 'Level', 'Message', 'Origin Type', 'orderId', 'http.status']);
      const cells = (id: string) =>
        Array.from(rowOf(id).querySelectorAll('[role="gridcell"]')).map(cell => cell.textContent?.trim());
      expect(cells(entryIds.payload).slice(-2)).toEqual(['ORD-1042', '502']);
      expect(cells(entryIds.invalid)[5]).toContain('invalid JSON');
      expect(cells(entryIds.text)[5]).toContain('plain text');
      expect(shownIds()).toHaveLength(3);
      expect(screen.getByRole('status')).toHaveTextContent('1 invalid JSON · 1 plain text');
    });

    it('filters the loaded entries by payload path, with a chip', () => {
      mountViewer({ entries: payloadEntries, fields: payloadFields });

      const input = screen.getByRole('combobox', { name: 'Filter logs' });
      fireEvent.change(input, { target: { value: 'http.status >= 500' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(shownIds()).toEqual([entryIds.payload]);
      expect(
        screen.getAllByTestId('filter-chip').map(chip => [chip.getAttribute('data-scope'), chip.textContent])
      ).toEqual([['loaded', 'http.status>=500']]);
      expect(screen.getByRole('status')).toHaveTextContent('1 of 3 entries shown');
      expect(screen.getByRole('status')).toHaveTextContent('1 invalid JSON · 1 plain text: skipped by JSON filters');
    });

    it('adds a payload leaf as a column and posts the added paths', () => {
      const { posted } = mountViewer({ entries: payloadEntries, fields: payloadFields });
      fireEvent.click(rowOf(entryIds.payload));

      const leaf = within(screen.getByTestId('custom-log-entry-detail')).getByTestId('payload-leaf-http.status');
      fireEvent.click(within(leaf).getByRole('button', { name: '+ Column' }));
      fireEvent.click(
        within(within(screen.getByTestId('custom-log-entry-detail')).getByTestId('payload-leaf-tags[0]')).getByRole(
          'button',
          { name: '= value' }
        )
      );

      expect(posts(posted, 'customLogViewerSetPayloadColumns')).toEqual([
        { type: 'customLogViewerSetPayloadColumns', added: ['http.status'] }
      ]);
      expect(shownIds()).toEqual([entryIds.payload]);
    });

    it('opens the full payload by key once the host lists it', () => {
      const { posted, bus } = mountViewer({ entries: payloadEntries, fields: payloadFields });
      fireEvent.click(rowOf(entryIds.payload));
      expect(screen.queryByRole('button', { name: 'Open full payload' })).toBeNull();

      send(bus, {
        type: 'customLogViewerEntryFields',
        entryId: entryIds.payload,
        fields: [{ key: 'payload', label: 'Payload', state: 'value', format: 'json' }]
      });
      fireEvent.click(screen.getByRole('button', { name: 'Open full payload' }));

      expect(posts(posted, 'customLogViewerOpenField')).toEqual([
        { type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: entryIds.payload, key: 'payload' } }
      ]);
    });

    it('lists a path that only the second page carries', () => {
      const { bus } = mountViewer({ entries: payloadEntries, fields: payloadFields });
      send(bus, {
        type: 'customLogViewerEntries',
        mode: 'append',
        entries: [makeEntry('a025g00000Hk1D2AAJ', 4, 'Page two', { payload: parsed({ region: 'us-east' }) })],
        payloadFields: [{ path: 'region', types: ['string'], rows: 1 }],
        hasMore: false
      });

      fireEvent.click(screen.getByRole('button', { name: '+ Field' }));

      expect(screen.getByRole('menuitemcheckbox', { name: /region/ })).toBeInTheDocument();
    });
  });

  describe('errors', () => {
    it('shows the error the host reports for each scope', () => {
      const { bus } = mountViewer();

      send(bus, { type: 'customLogViewerError', scope: 'apexLog', message: 'ApexLog was deleted' });

      expect(screen.getByRole('alert')).toHaveTextContent('Could not open the Apex log: ApexLog was deleted');
    });
  });
});
