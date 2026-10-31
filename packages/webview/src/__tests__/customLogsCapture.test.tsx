import { fireEvent, screen, within } from '@testing-library/react';
import type { CustomLogsToWebviewMessage } from '@alv/protocol/customLogsMessages';
import type {
  CustomLogCaptureStateView,
  CustomLogCaptureView,
  CustomLogRow,
  CustomLogSourceView,
  CustomLogStoreView
} from '@alv/protocol/customLogsTypes';

import {
  chips,
  grid,
  lastPost,
  listedTitles,
  makeRow,
  mountApp,
  nebula,
  posts,
  removeMountSequenceMeta,
  send,
  submit
} from './customLogsTestKit';

const mockScroller = Object.assign(new EventTarget(), { scrollTop: 0, scrollLeft: 0 });

jest.mock('react-window', () => {
  const React = require('react');
  return {
    List: ({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) => {
      const items = Array.from({ length: rowCount }).map((_: unknown, index: number) =>
        React.createElement(
          React.Fragment,
          { key: index },
          rowComponent({ ...rowProps, index, style: { height: rowHeight } })
        )
      );
      if (listRef && 'current' in listRef) {
        (listRef as { current: unknown }).current = { element: mockScroller, scrollToRow: () => {} };
      }
      return React.createElement('div', { 'data-testid': 'virtual-list', style, className }, items);
    }
  };
});

afterEach(() => {
  removeMountSequenceMeta();
  mockScroller.scrollTop = 0;
});

const BASE_MS = 1_790_000_000_000;

function eventRow(offsetMs: number, title: string): CustomLogRow {
  const id = [
    'e',
    (BASE_MS + offsetMs).toString(36).padStart(9, '0'),
    '0'.repeat(10),
    offsetMs.toString(16).padStart(32, '0')
  ].join('-');
  return makeRow(id, title, { time: new Date(BASE_MS + offsetMs).toISOString(), extra: {} });
}

const appEvents: CustomLogSourceView = {
  id: 'app-events',
  label: 'App events',
  origin: 'config',
  shape: 'events',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: false },
  payload: { entry: { field: 'Payload__c', columns: [] } },
  state: 'ready'
};

const EVENTS_ROOT = '/repo/apexlogs/orgs/dev/events/App_Log__e';

const CAPTURED: Extract<CustomLogStoreView, { state: 'captured' }> = {
  state: 'captured',
  eventsRoot: EVENTS_ROOT,
  oldest: '2026-10-02T09:14:03.120Z',
  newest: '2026-10-30T17:58:41.007Z',
  lastCaptureAt: '2026-10-30T17:58:52.311Z',
  sizeBytes: 19_293_184,
  retentionDays: 30,
  gaps: []
};
const NOT_CAPTURED: CustomLogStoreView = { state: 'notCaptured', eventsRoot: EVENTS_ROOT, retentionDays: 30 };

function capture(state: CustomLogCaptureStateView, rest: Partial<CustomLogCaptureView> = {}): CustomLogCaptureView {
  return { capture: state, store: CAPTURED, wanted: true, ...rest };
}

const strip = () => screen.getByRole('region', { name: 'Event capture' });
const queryStrip = () => screen.queryByRole('region', { name: 'Event capture' });
const stripStatus = () => within(strip()).getByRole('status');

function mountEvents(rows: CustomLogRow[] = [], hasMore = false) {
  return mountApp({ sources: [appEvents, nebula], selected: 'app-events', rows, fields: [], hasMore });
}

describe('capture strip', () => {
  it('is not there for a source that is not captured', () => {
    mountApp();

    expect(queryStrip()).toBeNull();
  });

  it('shows the state the host reports and goes away when the host clears it', () => {
    const { bus } = mountEvents();
    send(bus, { type: 'customLogsCapture', value: capture({ state: 'connecting' }) });

    expect(stripStatus()).toHaveTextContent('Connecting to App events…');

    send(bus, { type: 'customLogsCapture' });

    expect(queryStrip()).toBeNull();
  });

  const STATES = {
    connecting: { state: 'connecting' },
    standby: {
      state: 'standby',
      holder: { surface: 'cli', pid: 4242, host: 'build-7', since: '2026-10-31T08:00:00Z' }
    },
    catchingUp: { state: 'catchingUp', from: 'retained' },
    live: { state: 'live', basis: 'signal' },
    reconnecting: { state: 'reconnecting', attempt: 2, cause: 'overflow' },
    stopped: { state: 'stopped', outcome: 'aborted' },
    failed: { state: 'failed', code: 'CUSTOM_LOG_CAPTURE_FAILED', message: 'The cursor was rejected twice.' }
  } satisfies { [S in CustomLogCaptureStateView['state']]: Extract<CustomLogCaptureStateView, { state: S }> };

  it.each(Object.entries(STATES))('renders the %s state with a sentence and a button', (name, state) => {
    const { bus } = mountEvents();
    send(bus, { type: 'customLogsCapture', value: capture(state) });

    expect(strip()).toHaveAttribute('data-state', name);
    expect(stripStatus().textContent).not.toBe('');
    expect(within(strip()).getAllByRole('button').length).toBeGreaterThan(0);
  });

  describe('actions', () => {
    it('posts a stop while capture runs', () => {
      const { bus, posted } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }) });

      fireEvent.click(within(strip()).getByRole('button', { name: 'Stop' }));

      expect(lastPost(posted, 'customLogsCapture')).toEqual({ type: 'customLogsCapture', action: 'stop' });
    });

    it('does not offer a second stop once the user pressed the first', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }, { wanted: false }) });

      expect(within(strip()).queryByRole('button')).toBeNull();
    });

    it('posts a start without a choice after a stop, a budget pause or a failure', () => {
      const { bus, posted } = mountEvents();
      const ended: CustomLogCaptureView[] = [
        capture({ state: 'stopped', outcome: 'aborted' }, { wanted: false }),
        capture({ state: 'stopped', outcome: 'budget' }, { allowance: { budget: 4_206 } }),
        capture({ state: 'failed', code: 'CUSTOM_LOG_CAPTURE_FAILED', message: 'x' })
      ];
      for (const value of ended) {
        send(bus, { type: 'customLogsCapture', value });
        fireEvent.click(within(strip()).getByRole('button', { name: 'Start' }));
      }

      expect(posts(posted, 'customLogsCapture')).toEqual(Array(3).fill({ type: 'customLogsCapture', action: 'start' }));
    });
  });

  describe('first use', () => {
    const firstUse = capture(
      { state: 'stopped', outcome: 'needsInitial' },
      { store: NOT_CAPTURED, allowance: { remaining: 8_412, max: 10_000, budget: 4_206 } }
    );

    it('asks what to load, and explains the cost to the first button, before anything is subscribed', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: firstUse });

      expect(stripStatus()).toHaveTextContent('No events from this org are stored yet.');
      expect(within(strip()).queryByRole('button', { name: 'Start' })).toBeNull();
      expect(within(strip()).getByRole('button', { name: 'Load retained events' })).toHaveAccessibleDescription(
        "Salesforce keeps up to 72 hours; each event counts against the org's daily delivery allocation (about 8,412 of 10,000 left); this run stops after about 4,206 deliveries and resumes on the next Start."
      );
    });

    it('posts the choice the user makes', () => {
      const { bus, posted } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: firstUse });

      fireEvent.click(within(strip()).getByRole('button', { name: 'Load retained events' }));
      fireEvent.click(within(strip()).getByRole('button', { name: 'Only new events' }));

      expect(posts(posted, 'customLogsCapture')).toEqual([
        { type: 'customLogsCapture', action: 'start', initial: 'retained' },
        { type: 'customLogsCapture', action: 'start', initial: 'new' }
      ]);
    });

    it('lets the strip explain the empty list instead of saying no logs were found', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: firstUse });

      expect(screen.queryByText(/No logs found/)).toBeNull();
    });

    it('still says so when a captured store has nothing that matches', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }) });

      expect(screen.getByText(/No logs found/)).toBeInTheDocument();
    });
  });

  describe('live', () => {
    it('tells the user the state is inferred, to a pointer and to a screen reader', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'quiet' }) });

      const label = within(stripStatus()).getByText('Live');
      expect(label).toHaveAttribute('title', 'Inferred: no event for 10 s. Salesforce sends no end-of-backlog marker.');
      expect(label).toHaveAccessibleDescription(
        'Inferred: no event for 10 s. Salesforce sends no end-of-backlog marker.'
      );
      expect(label).toHaveAttribute('tabindex', '0');
    });

    it('adds no tooltip when the server signalled it', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }) });

      expect(within(stripStatus()).getByText('Live')).not.toHaveAttribute('title');
    });
  });

  describe('for a screen reader', () => {
    const gap = {
      reason: 'cursorRejected',
      after: '2026-10-21T18:02:11.000Z',
      before: '2026-10-25T09:40:02.554Z',
      detectedAt: '2026-10-28T08:00:01.002Z'
    } as const;
    const openGap = {
      reason: 'orgChanged',
      after: '2026-10-29T10:00:00.000Z',
      detectedAt: '2026-10-30T08:00:00.000Z'
    } as const;

    it('keeps the state, the cause of a reconnect and each gap in separate places', () => {
      const { bus } = mountEvents();
      send(bus, {
        type: 'customLogsCapture',
        value: capture(
          { state: 'reconnecting', attempt: 2, cause: 'overflow' },
          { store: { ...CAPTURED, gaps: [gap, openGap] } }
        )
      });

      expect(stripStatus()).toHaveTextContent('Reconnecting (attempt 2) after a burst of events…');
      expect(stripStatus()).not.toHaveTextContent('may be missing');

      const gaps = within(strip()).getByRole('list', { name: 'Possible gaps in the stored events' });
      const items = within(gaps).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent(
        /^Events between .+ and .+ may be missing \(Salesforce rejected the stored position when capture resumed\)$/
      );
      expect(items[1]).toHaveTextContent(
        /^Events after .+ may be missing \(this username now points to another org\)$/
      );
      expect(gaps).not.toHaveTextContent('Reconnecting');
    });

    it('lists no gaps when the store has none', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }) });

      expect(within(strip()).queryByRole('list')).toBeNull();
    });

    it('does not announce the decorative icons', () => {
      const { bus } = mountEvents();
      send(bus, {
        type: 'customLogsCapture',
        value: capture({ state: 'live', basis: 'signal' }, { store: { ...CAPTURED, gaps: [gap] } })
      });

      for (const icon of strip().querySelectorAll('svg')) {
        expect(icon).toHaveAttribute('aria-hidden', 'true');
      }
    });
  });

  describe('filters over stored events', () => {
    it('say they run over the stored events, where a record source says Salesforce', () => {
      const { bus } = mountEvents();
      send(bus, { type: 'customLogsCapture', value: capture({ state: 'live', basis: 'signal' }) });
      submit('level >= WARN');

      expect(chips().map(chip => chip.getAttribute('title'))).toContain(
        'Runs over the stored events: changes the list without asking Salesforce'
      );

      send(bus, { type: 'customLogsCapture' });

      expect(chips().map(chip => chip.getAttribute('title'))).toContain(
        'Runs in Salesforce: changes the query and reloads the list'
      );
    });
  });
});

describe('live rows', () => {
  const stored = [
    eventRow(50, 'stored 50'),
    eventRow(40, 'stored 40'),
    eventRow(30, 'stored 30'),
    eventRow(20, 'stored 20')
  ];

  it('join the list newest first without a reload', () => {
    const { bus, posted } = mountEvents(stored);
    const before = posted.length;

    send(bus, {
      type: 'customLogsLiveRows',
      rows: [eventRow(60, 'live 60'), eventRow(45, 'live 45')],
      payloadFields: []
    });

    expect(listedTitles()).toEqual(['live 60', 'stored 50', 'live 45', 'stored 40', 'stored 30', 'stored 20']);
    expect(posted.length).toBe(before);
  });

  it('show a row once, however often the host sends it', () => {
    const { bus } = mountEvents(stored);
    const batch: CustomLogsToWebviewMessage = {
      type: 'customLogsLiveRows',
      rows: [eventRow(60, 'live 60')],
      payloadFields: []
    };

    send(bus, batch);
    send(bus, batch);

    expect(listedTitles().filter(title => title === 'live 60')).toHaveLength(1);
  });

  it('keep the row at the top of the viewport where it is when they arrive above it', () => {
    const { bus } = mountEvents(stored);
    mockScroller.scrollTop = 48;

    send(bus, {
      type: 'customLogsLiveRows',
      rows: [eventRow(70, 'live 70'), eventRow(60, 'live 60')],
      payloadFields: []
    });

    expect(listedTitles().slice(0, 2)).toEqual(['live 70', 'live 60']);
    expect(mockScroller.scrollTop).toBe(48 + 2 * 24);
  });

  it('follow the newest row when the list is scrolled to the top', () => {
    const { bus } = mountEvents(stored);

    send(bus, { type: 'customLogsLiveRows', rows: [eventRow(70, 'live 70')], payloadFields: [] });

    expect(mockScroller.scrollTop).toBe(0);
  });

  it('leave the viewport alone when they land below the first visible row', () => {
    const { bus } = mountEvents(stored);
    mockScroller.scrollTop = 24;

    send(bus, { type: 'customLogsLiveRows', rows: [eventRow(25, 'live 25')], payloadFields: [] });

    expect(mockScroller.scrollTop).toBe(24);
  });

  it('keep the selected row selected', () => {
    const { bus } = mountEvents(stored);
    fireEvent.click(within(grid()).getByText('stored 40'));

    send(bus, { type: 'customLogsLiveRows', rows: [eventRow(70, 'live 70')], payloadFields: [] });

    const selected = within(grid())
      .getAllByRole('row')
      .filter(row => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('stored 40');
  });
});
