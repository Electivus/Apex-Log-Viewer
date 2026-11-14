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

const mockScrolledRows: number[] = [];

jest.mock('react-window', () => {
  const React = require('react');
  return {
    // Like react-window's List over dynamic row heights: each row is laid out at its measured height, or at the
    // average before it measured, and the rendered rows go to `observeRowElements` after every render.
    List: ({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) => {
      const listElement = React.useRef(null);
      const items = Array.from({ length: rowCount }).map((_: unknown, index: number) =>
        React.createElement(rowComponent, {
          key: index,
          ...rowProps,
          index,
          style: { height: rowHeight.getRowHeight(index) ?? rowHeight.getAverageRowHeight() }
        })
      );
      React.useLayoutEffect(() => rowHeight.observeRowElements(Array.from(listElement.current.children)));
      const api = { element: null, scrollToRow: ({ index }: { index: number }) => mockScrolledRows.push(index) };
      // Like react-window's List: the handle reaches object and callback refs alike.
      React.useImperativeHandle(listRef, () => api, []);
      return React.createElement('div', { ref: listElement, 'data-testid': 'virtual-list', style, className }, items);
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
  return { vscode, posted, getSavedState: () => savedState };
}

function send(bus: EventTarget, message: CustomLogViewerToWebviewMessage) {
  act(() => {
    bus.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

type MountOptions = {
  log?: CustomLogRow;
  entries?: CustomLogEntry[];
  fields?: CustomLogPayloadField[];
  apexLog?: CustomLogApexLogLink;
  logPayload?: CustomLogLongFieldView;
  defaults?: string[];
  added?: string[];
  hasMore?: boolean;
  locale?: string;
};

function mountViewer(options: MountOptions = {}, initialState?: unknown) {
  const mock = createVsCodeMock(initialState);
  const bus = new EventTarget();
  const view = render(<CustomLogViewerApp vscode={mock.vscode} messageBus={bus} />);
  send(bus, {
    type: 'customLogViewerInit',
    locale: options.locale ?? 'en',
    source: { id: 'nebula-managed', label: 'Nebula Logger (managed)', shape: 'transactions' },
    log: options.log ?? log,
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
const viewerSearch = () => screen.getByRole('searchbox', { name: 'Search entries…' });
const levelGroup = () => screen.getByRole('group', { name: 'Filter by level' });
const detailGroup = () => screen.getByRole('group', { name: 'Filter by long field' });
const loadMoreLabel = () => within(screen.getByRole('status')).getByRole('button').textContent;
const posts = <T extends CustomLogViewerFromWebviewMessage['type']>(
  posted: CustomLogViewerFromWebviewMessage[],
  type: T
) =>
  posted.filter((message): message is Extract<CustomLogViewerFromWebviewMessage, { type: T }> => message.type === type);

describe('Custom Log viewer app', () => {
  describe('entry columns', () => {
    it('shows a null record field as an empty cell, not the word null', () => {
      mountViewer({
        entries: [makeEntry(entryIds.start, 1, 'Starting order sync', { extra: { OriginType__c: null } })]
      });

      expect(rowOf(entryIds.start).textContent).not.toContain('null');
      expect(rowOf(entryIds.start).textContent).toContain('—');
    });
  });

  describe('header', () => {
    it('announces itself, then shows the log the host sends', () => {
      const { posted } = mountViewer();

      expect(posted).toEqual([{ type: 'customLogViewerReady' }]);
      expect(screen.getByTestId('custom-log-viewer-title')).toHaveTextContent('Log-000739');
      const header = screen.getByRole('banner');
      expect(header).toHaveTextContent('Nebula Logger (managed)');
      expect(header).toHaveTextContent('dev@acme.com');
      expect(header).toHaveTextContent('33 entries');
      expect(header).toHaveTextContent('1 error');
      expect(header).not.toHaveTextContent('1 errors');
      expect(header).toHaveTextContent('1 warning');
      expect(header).not.toHaveTextContent('1 warnings');
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

    it('tells a user who cannot read debug logs apart from a request that has none', () => {
      mountViewer({ apexLog: { state: 'unavailable', reason: 'noAccess' } });

      expect(screen.queryByRole('button', { name: 'Open Apex log' })).toBeNull();
      expect(screen.getByTestId('custom-log-apex-hint')).toHaveTextContent('You cannot read debug logs in this org.');
      expect(screen.getByTestId('custom-log-apex-hint')).not.toHaveTextContent('trace flag');
    });

    it('says the org could not be reached, not that the user lacks access, when the lookup was offline', () => {
      mountViewer({ apexLog: { state: 'unavailable', reason: 'offline' } });

      expect(screen.queryByRole('button', { name: 'Open Apex log' })).toBeNull();
      expect(screen.getByTestId('custom-log-apex-hint')).toHaveTextContent(
        'Could not reach the org to look up the Apex debug log for this request.'
      );
      expect(screen.getByTestId('custom-log-apex-hint')).not.toHaveTextContent('You cannot read debug logs');
    });

    it('pluralizes the header counts', () => {
      mountViewer({ log: { ...log, counts: { entries: 1, errors: 2, warnings: 1 } } });

      const header = screen.getByRole('banner');
      expect(header).toHaveTextContent('1 entry');
      expect(header).toHaveTextContent('2 errors');
      expect(header).toHaveTextContent('1 warning');
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
      expect(screen.getByRole('banner')).toHaveTextContent('1 erro');
      expect(screen.getByRole('banner')).not.toHaveTextContent('1 erros');
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

    it('counts a single loaded entry in the singular', () => {
      mountViewer({ entries: entries.slice(0, 1) });

      expect(screen.getByRole('status')).toHaveTextContent('1 entry loaded');
      expect(screen.getByRole('status')).not.toHaveTextContent('1 entries loaded');
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
        screen.getByText(`No loaded entry matches the current filters. Use ${loadMoreLabel()} to widen the search.`)
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

  describe('row heights', () => {
    const nextFrame = () => act(async () => await new Promise(resolve => setTimeout(resolve, 20)));
    const heightOf = (id: string) => (rowOf(id).parentElement as HTMLElement).style.height;
    const NoResizeObserver = globalThis.ResizeObserver;

    beforeEach(() => {
      // A browser reports each observed row's size soon after it lays the row out: the first entry wraps to 61 px.
      globalThis.ResizeObserver = class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const entryId = target.querySelector('[data-entry-id]')?.getAttribute('data-entry-id');
          const blockSize = entryId === entryIds.start ? 61 : 26;
          setTimeout(() =>
            this.callback(
              [{ target, borderBoxSize: [{ blockSize, inlineSize: 800 }] } as unknown as ResizeObserverEntry],
              this as unknown as ResizeObserver
            )
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      globalThis.ResizeObserver = NoResizeObserver;
    });

    it('keeps the measured height of a row that stays when the system switch shows more rows', async () => {
      mountViewer();
      await nextFrame();
      expect(heightOf(entryIds.start)).toBe('61px');

      fireEvent.click(screen.getByRole('switch', { name: /Show logger system messages/ }));
      await nextFrame();

      expect(heightOf(entryIds.start)).toBe('61px');
      expect(heightOf(entryIds.system)).toBe('26px');
    });

    it('keeps the measured height of a row when a level filter narrows the list', async () => {
      mountViewer();
      await nextFrame();

      fireEvent.click(within(levelGroup()).getByRole('button', { name: /INFO/ }));
      await nextFrame();

      expect(heightOf(entryIds.start)).toBe('61px');
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

    it("asks for the selected entry's long fields again when a refresh replaces the entries", () => {
      const { posted, bus } = mountViewer();
      fireEvent.click(rowOf(entryIds.error));
      send(bus, { type: 'customLogViewerEntryFields', entryId: entryIds.error, fields });

      send(bus, { type: 'customLogViewerEntries', mode: 'replace', entries, payloadFields: [], hasMore: false });

      expect(
        posts(posted, 'customLogViewerOpenEntry').filter(message => message.entryId === entryIds.error)
      ).toHaveLength(2);
      const detail = screen.getByTestId('custom-log-entry-detail');
      expect(within(detail).queryByTestId('entry-field-message')).toBeNull();
      send(bus, { type: 'customLogViewerEntryFields', entryId: entryIds.error, fields });
      expect(within(detail).getByTestId('entry-field-message')).toBeInTheDocument();
    });

    it('asks for nothing after a refresh when the selected entry is no longer listed', () => {
      const { posted, bus } = mountViewer();
      fireEvent.click(rowOf(entryIds.error));

      send(bus, {
        type: 'customLogViewerEntries',
        mode: 'replace',
        entries: entries.filter(entry => entry.id !== entryIds.error),
        payloadFields: [],
        hasMore: false
      });

      expect(posts(posted, 'customLogViewerOpenEntry')).toHaveLength(1);
      expect(screen.queryByTestId('custom-log-entry-detail')).toBeNull();
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

    it('asks the host to copy the message it holds, never the preview, and closes', () => {
      const preview = 'x'.repeat(2000);
      const clipped = makeEntry('a025g00000Hk1D1AAJ', 9, preview, { previewClipped: true, messageTruncated: true });
      const { posted, bus } = mountViewer({ entries: [clipped] });
      fireEvent.click(rowOf(clipped.id));

      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
      send(bus, { type: 'customLogViewerEntryFields', entryId: clipped.id, fields });
      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

      const copy = { type: 'customLogViewerCopyField', target: { kind: 'entry', entryId: clipped.id, key: 'message' } };
      expect(posts(posted, 'customLogViewerCopyField')).toEqual([copy, copy]);
      expect(JSON.stringify(posted).includes(preview)).toBe(false);
      expect(
        within(screen.getByTestId('custom-log-entry-detail')).getAllByText(/truncated by the logger/)
      ).not.toHaveLength(0);

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

    it('searches the payload paths and values and the record columns of the loaded entries', () => {
      const tagged = makeEntry(entryIds.debug, 4, 'Tagged', { extra: { OriginType__c: 'Flow' } });
      mountViewer({ entries: [...payloadEntries, tagged], fields: payloadFields });

      fireEvent.change(viewerSearch(), { target: { value: 'http.status 502' } });
      expect(shownIds()).toEqual([entryIds.payload]);
      expect(screen.getByRole('status')).toHaveTextContent('1 of 4 entries shown');
      expect(screen.getByRole('status')).toHaveTextContent('1 invalid JSON · 1 plain text');

      fireEvent.change(viewerSearch(), { target: { value: 'flow' } });
      expect(shownIds()).toEqual([entryIds.debug]);

      fireEvent.change(viewerSearch(), { target: { value: 'origintype__c' } });
      expect(shownIds()).toEqual([]);
    });

    it('reads operators and quotes as plain text, and finds a root-array path as core wrote it', () => {
      const failed = makeEntry(entryIds.payload, 1, 'Batch failed', { payload: parsed({ '[0].status': 500 }) });
      const ok = makeEntry(entryIds.debug, 2, 'Batch ok', { payload: parsed({ '[0].status': 200 }) });
      mountViewer({ entries: [failed, ok], fields: [{ path: '[0].status', types: ['number'], rows: 2 }] });

      fireEvent.change(viewerSearch(), { target: { value: '[].status >= 500' } });
      expect(shownIds()).toEqual([]);

      fireEvent.change(viewerSearch(), { target: { value: '[0].status 500' } });
      expect(shownIds()).toEqual([entryIds.payload]);
    });

    it('keeps the search when the webview is restored, and clears it with its button', () => {
      const first = mountViewer({ entries: payloadEntries, fields: payloadFields });
      fireEvent.change(viewerSearch(), { target: { value: 'ORD-1042' } });
      const saved = first.getSavedState();
      first.view.unmount();

      mountViewer({ entries: payloadEntries, fields: payloadFields }, saved);
      expect(viewerSearch()).toHaveValue('ORD-1042');
      expect(shownIds()).toEqual([entryIds.payload]);

      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(shownIds()).toHaveLength(3);
    });

    it('focuses the search on /', () => {
      mountViewer();

      fireEvent.keyDown(document.body, { key: '/' });

      expect(viewerSearch()).toHaveFocus();
    });

    it('adds a payload leaf as a column and posts that one column', () => {
      const { posted } = mountViewer({ entries: payloadEntries, fields: payloadFields });
      fireEvent.click(rowOf(entryIds.payload));

      const leaf = within(screen.getByTestId('custom-log-entry-detail')).getByTestId('payload-leaf-http.status');
      expect(
        within(leaf)
          .getAllByRole('button')
          .map(button => button.textContent)
      ).toEqual(['+ Column']);
      fireEvent.click(within(leaf).getByRole('button', { name: '+ Column' }));

      expect(posts(posted, 'customLogViewerShowPayloadColumn')).toEqual([
        { type: 'customLogViewerShowPayloadColumn', path: 'http.status', shown: true }
      ]);
      expect(shownIds()).toHaveLength(3);
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

    it('keeps a saved sort on a JSON column when the webview is restored', () => {
      const byStatus = [
        makeEntry(entryIds.start, 1, 'Synced', { payload: parsed({ 'http.status': 200 }) }),
        makeEntry(entryIds.error, 2, 'Bad gateway', { payload: parsed({ 'http.status': 502 }) }),
        makeEntry(entryIds.warn, 3, 'Throttled', { payload: parsed({ 'http.status': 429 }) })
      ];
      const options = {
        entries: byStatus,
        fields: [{ path: 'http.status', types: ['number' as const], rows: 3 }],
        added: ['http.status']
      };
      const first = mountViewer(options);
      fireEvent.click(screen.getByRole('button', { name: 'Column menu for http.status' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sort descending' }));
      expect(shownIds()).toEqual([entryIds.error, entryIds.warn, entryIds.start]);
      const saved = first.getSavedState();
      first.view.unmount();

      mountViewer(options, saved);

      expect(shownIds()).toEqual([entryIds.error, entryIds.warn, entryIds.start]);
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

  describe('opening an entry from the list', () => {
    const focus = (bus: EventTarget, entryId: string, state: 'found' | 'notLoaded' | 'notFound' = 'found') =>
      send(bus, { type: 'customLogViewerFocus', entryId, state });
    const systemSwitch = () => screen.getByRole('switch', { name: /Show logger system messages/ });

    beforeEach(() => {
      mockScrolledRows.length = 0;
    });

    it('selects the entry, scrolls to it and asks for its long fields', () => {
      const { bus, posted } = mountViewer();

      focus(bus, entryIds.warn);

      expect(rowOf(entryIds.warn)).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('custom-log-entry-detail')).toHaveTextContent('Retrying after timeout');
      expect(posts(posted, 'customLogViewerOpenEntry')).toEqual([
        { type: 'customLogViewerOpenEntry', entryId: entryIds.warn }
      ]);
      expect(mockScrolledRows).toEqual([shownIds().indexOf(entryIds.warn)]);
    });

    it('shows logger system messages to land on a system entry', () => {
      const { bus } = mountViewer();
      expect(rowOf(entryIds.system)).toBeNull();

      focus(bus, entryIds.system);

      expect(systemSwitch()).toBeChecked();
      expect(rowOf(entryIds.system)).toHaveAttribute('aria-selected', 'true');
      expect(mockScrolledRows).toEqual([shownIds().indexOf(entryIds.system)]);
    });

    it('drops only the filters that hide the entry, once, and leaves later filters to the user', () => {
      const { bus } = mountViewer();
      fireEvent.click(within(levelGroup()).getByRole('button', { name: /ERROR/ }));
      fireEvent.change(viewerSearch(), { target: { value: 'divide' } });
      expect(shownIds()).toEqual([entryIds.error]);

      focus(bus, entryIds.warn);

      expect(viewerSearch()).toHaveValue('');
      expect(within(levelGroup()).getByRole('button', { name: /ERROR/ })).toHaveAttribute('aria-pressed', 'false');
      expect(systemSwitch()).not.toBeChecked();
      expect(rowOf(entryIds.warn)).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(within(levelGroup()).getByRole('button', { name: /ERROR/ }));
      expect(shownIds()).toEqual([entryIds.error]);
    });

    it('keeps a search the entry matches', () => {
      const { bus } = mountViewer();
      fireEvent.change(viewerSearch(), { target: { value: 'httpclient' } });

      focus(bus, entryIds.warn);

      expect(viewerSearch()).toHaveValue('httpclient');
      expect(shownIds()).toEqual([entryIds.warn, entryIds.debug]);
      expect(mockScrolledRows).toEqual([0]);
    });

    it('lands on a second entry of the same log when the list opens it', () => {
      const { bus } = mountViewer();
      focus(bus, entryIds.warn);

      focus(bus, entryIds.start);

      expect(rowOf(entryIds.start)).toHaveAttribute('aria-selected', 'true');
      expect(rowOf(entryIds.warn)).toHaveAttribute('aria-selected', 'false');
      expect(mockScrolledRows).toEqual([shownIds().indexOf(entryIds.warn), shownIds().indexOf(entryIds.start)]);
    });

    it('says the entry lies past the loaded entries, then lands on it once Load more brings it in', () => {
      const late = makeEntry('a025g00000Hk1C9AAJ', 6, 'Order 9 synced');
      const { bus } = mountViewer({ hasMore: true });
      const label = loadMoreLabel();

      focus(bus, late.id, 'notLoaded');
      expect(screen.getByTestId('custom-log-focus-notice')).toHaveTextContent(
        `The entry you opened comes after the 5 loaded entries. Use ${label} to reach it.`
      );

      send(bus, { type: 'customLogViewerEntries', mode: 'append', entries: [late], payloadFields: [], hasMore: true });
      focus(bus, late.id);

      expect(screen.queryByTestId('custom-log-focus-notice')).toBeNull();
      expect(rowOf(late.id)).toHaveAttribute('aria-selected', 'true');
    });

    it('names the Load more button the pt-BR viewer shows in both of its hints', () => {
      const { bus } = mountViewer({ hasMore: true, locale: 'pt-BR' });
      const label = loadMoreLabel();

      focus(bus, 'a025g00000Hk1C9AAJ', 'notLoaded');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nada aqui' } });

      expect(label).toBe('Carregar mais');
      expect(screen.getByTestId('custom-log-focus-notice')).toHaveTextContent(
        `A entrada que você abriu vem depois das 5 entradas carregadas. Use ${label} para chegar até ela.`
      );
      expect(
        screen.getByText(`Nenhuma entrada carregada corresponde aos filtros atuais. Use ${label} para ampliar a busca.`)
      ).toBeInTheDocument();
    });

    it('says when the entry is no longer in the log, until dismissed', () => {
      const { bus } = mountViewer();

      focus(bus, 'a025g00000Hk1C9AAJ', 'notFound');
      expect(screen.getByTestId('custom-log-focus-notice')).toHaveTextContent(
        'The entry you opened is no longer in this log.'
      );
      expect(grid().querySelector('[aria-selected="true"]')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('custom-log-focus-notice')).toBeNull();
    });

    it('lands on the entry Load more brings in after its notice was dismissed', () => {
      const late = makeEntry('a025g00000Hk1C9AAJ', 6, 'Order 9 synced');
      const { bus, posted } = mountViewer({ hasMore: true });
      focus(bus, entryIds.warn);
      focus(bus, late.id, 'notLoaded');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      mockScrolledRows.length = 0;
      posted.length = 0;

      send(bus, { type: 'customLogViewerEntries', mode: 'append', entries: [late], payloadFields: [], hasMore: false });
      focus(bus, late.id);

      expect(rowOf(late.id)).toHaveAttribute('aria-selected', 'true');
      expect(rowOf(entryIds.warn)).toHaveAttribute('aria-selected', 'false');
      expect(mockScrolledRows).toEqual([shownIds().indexOf(late.id)]);
      expect(posts(posted, 'customLogViewerOpenEntry')).toEqual([
        { type: 'customLogViewerOpenEntry', entryId: late.id }
      ]);
    });

    it('lands on the next entry the list opens after the notice of a gone entry was dismissed', () => {
      const { bus, posted } = mountViewer();
      focus(bus, entryIds.warn);
      focus(bus, 'a025g00000Hk1C9AAJ', 'notFound');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      mockScrolledRows.length = 0;
      posted.length = 0;

      focus(bus, entryIds.start);

      expect(rowOf(entryIds.start)).toHaveAttribute('aria-selected', 'true');
      expect(mockScrolledRows).toEqual([shownIds().indexOf(entryIds.start)]);
      expect(posts(posted, 'customLogViewerOpenEntry')).toEqual([
        { type: 'customLogViewerOpenEntry', entryId: entryIds.start }
      ]);
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
