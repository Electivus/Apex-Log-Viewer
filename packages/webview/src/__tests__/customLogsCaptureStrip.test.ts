import type {
  CustomLogCaptureOutcomeView,
  CustomLogCaptureStateView,
  CustomLogCaptureView,
  CustomLogStoreGapView,
  CustomLogStoreView
} from '@alv/protocol/customLogsTypes';
import { getMessages } from '../i18n';
import { gapLinesOf, stripViewOf, type StripContext } from '../utils/customLogs/captureStrip';
import { formatMinute } from '../utils/customLogs/format';

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

function contextFor(locale: 'en' | 'pt-br'): StripContext {
  return { t: getMessages(locale).customLogs, locale, sourceLabel: 'App events' };
}
const en = contextFor('en');

function viewOf(capture: CustomLogCaptureStateView, rest: Partial<CustomLogCaptureView> = {}): CustomLogCaptureView {
  return { capture, store: CAPTURED, wanted: true, ...rest };
}

/** Every capture state, so adding one to the protocol fails this table until the strip says something about it. */
const STATES = {
  connecting: { state: 'connecting' },
  standby: { state: 'standby', holder: { surface: 'cli', pid: 4242, host: 'build-7', since: '2026-10-31T08:00:00Z' } },
  catchingUp: { state: 'catchingUp', from: 'position' },
  live: { state: 'live', basis: 'quiet' },
  reconnecting: { state: 'reconnecting', attempt: 2, cause: 'transport' },
  stopped: { state: 'stopped', outcome: 'aborted' },
  failed: { state: 'failed', code: 'CUSTOM_LOG_CAPTURE_FAILED', message: 'The cursor was rejected twice.' }
} satisfies { [S in CustomLogCaptureStateView['state']]: Extract<CustomLogCaptureStateView, { state: S }> };

describe('capture strip text', () => {
  it.each(Object.values(STATES))('has a status sentence and a way out for the %j state', capture => {
    const view = stripViewOf(viewOf(capture), en);

    expect(view.text.length).toBeGreaterThan(0);
    expect(view.text).not.toMatch(/\{\w+\}/);
    expect(view.actions.length).toBeGreaterThan(0);
  });

  it('names the source being connected', () => {
    expect(stripViewOf(viewOf(STATES.connecting), en).text).toBe('Connecting to App events…');
  });

  it('offers Stop while capture runs and nothing while the user has already asked to stop', () => {
    const running: CustomLogCaptureStateView[] = [
      STATES.connecting,
      STATES.standby,
      STATES.catchingUp,
      STATES.live,
      STATES.reconnecting
    ];
    for (const capture of running) {
      expect(stripViewOf(viewOf(capture), en).actions).toEqual(['stop']);
      expect(stripViewOf(viewOf(capture, { wanted: false }), en).actions).toEqual([]);
    }
  });

  it('offers Start once capture has ended or failed, whatever the user asked before', () => {
    const outcomes: CustomLogCaptureOutcomeView[] = ['quiet', 'timeLimit', 'budget', 'aborted', 'capturedElsewhere'];
    for (const outcome of outcomes) {
      expect(stripViewOf(viewOf({ state: 'stopped', outcome }, { wanted: false }), en).actions).toEqual(['start']);
    }
    expect(stripViewOf(viewOf(STATES.failed), en).actions).toEqual(['start']);
  });

  describe('live', () => {
    it('shows when the stored history starts and how big it is', () => {
      const view = stripViewOf(viewOf({ state: 'live', basis: 'signal' }), en);

      expect(view.label).toBe('Live');
      expect(view.text).toBe(`stored since ${formatMinute(CAPTURED.oldest!)} · 18.4 MB`);
    });

    it('explains that quiet means inferred, and says nothing when the server signalled it', () => {
      expect(stripViewOf(viewOf({ state: 'live', basis: 'quiet' }), en).hint).toBe(
        'Inferred: no event for 10 s. Salesforce sends no end-of-backlog marker.'
      );
      expect(stripViewOf(viewOf({ state: 'live', basis: 'signal' }), en).hint).toBeUndefined();
    });

    it('says nothing is stored yet instead of a date, for a store with no events or none captured', () => {
      const empty = stripViewOf(
        viewOf(STATES.live, { store: { ...CAPTURED, oldest: undefined, newest: undefined } }),
        en
      );
      const never = stripViewOf(viewOf(STATES.live, { store: NOT_CAPTURED }), en);

      expect(empty.text).toBe('no events stored yet');
      expect(never.text).toBe('no events stored yet');
    });
  });

  describe('catching up', () => {
    it.each([
      [
        { state: 'catchingUp', from: 'position' },
        `Catching up: loading events Salesforce kept since ${formatMinute(CAPTURED.lastCaptureAt)}`
      ],
      [{ state: 'catchingUp', from: 'retained' }, 'Loading retained events (up to 72 hours)…'],
      [{ state: 'catchingUp', from: 'new' }, 'Waiting for new events…']
    ] as const)('says where %j starts', (capture, text) => {
      expect(stripViewOf(viewOf(capture), en).text).toBe(text);
    });
  });

  describe('reconnecting', () => {
    it.each([
      ['transport', 'Reconnecting (attempt 3) after the connection dropped…'],
      ['auth', 'Reconnecting (attempt 3) after Salesforce rejected the session…'],
      ['overflow', 'Reconnecting (attempt 3) after a burst of events…']
    ] as const)('names the %s cause', (cause, text) => {
      expect(stripViewOf(viewOf({ state: 'reconnecting', attempt: 3, cause }), en).text).toBe(text);
    });
  });

  describe('standby', () => {
    it('names the process that holds the lease, by surface, pid and host', () => {
      const cli = stripViewOf(viewOf(STATES.standby), en);
      const window = stripViewOf(
        viewOf({
          state: 'standby',
          holder: { surface: 'vscode', pid: 91, host: 'laptop', since: '2026-10-31T08:00:00Z' }
        }),
        en
      );

      expect(cli.text).toBe('Another sf command (pid 4242 on build-7) is capturing; new events appear here.');
      expect(window.text).toBe('Another VS Code window (pid 91 on laptop) is capturing; new events appear here.');
    });

    it('tells the user which file to delete when the holder no longer exists, and where it is', () => {
      expect(stripViewOf(viewOf(STATES.standby), en).detail).toBe(
        `If no such process exists (the host name may have changed), delete capture.lease in ${EVENTS_ROOT}.`
      );
    });
  });

  describe('stopped', () => {
    it.each(['quiet', 'timeLimit', 'aborted'] as const)('keeps the stored range visible after %s', outcome => {
      const view = stripViewOf(viewOf({ state: 'stopped', outcome }), en);

      expect(view.label).toBe('Stopped');
      expect(view.text).toBe(`stored since ${formatMinute(CAPTURED.oldest!)} · 18.4 MB`);
    });

    it('says the run spent its budget, as about, and that Start resumes from the stored position', () => {
      const view = stripViewOf(
        viewOf(
          { state: 'stopped', outcome: 'budget' },
          { allowance: { remaining: 8_412, max: 10_000, budget: 4_206 } }
        ),
        en
      );

      expect(view.tone).toBe('attention');
      expect(view.text).toBe(
        "Paused: this run spent its delivery budget (about 4,206 deliveries of the org's daily allocation). Start to resume from the stored position."
      );
    });

    it('still says it when the allowance is unknown', () => {
      expect(stripViewOf(viewOf({ state: 'stopped', outcome: 'budget' }), en).text).toBe(
        'Paused: this run spent its delivery budget. Start to resume from the stored position.'
      );
    });

    it('says another process captures these events, with the lease note, when this one lost the election', () => {
      const view = stripViewOf(viewOf({ state: 'stopped', outcome: 'capturedElsewhere' }), en);

      expect(view.text).toBe('Another VS Code window or sf command is capturing these events. Start to check again.');
      expect(view.detail).toContain('delete capture.lease');
    });
  });

  describe('first use', () => {
    const needsInitial: CustomLogCaptureStateView = { state: 'stopped', outcome: 'needsInitial' };

    it('offers the two choices and no Start', () => {
      const view = stripViewOf(viewOf(needsInitial, { store: NOT_CAPTURED }), en);

      expect(view.text).toBe('No events from this org are stored yet.');
      expect(view.actions).toEqual(['loadRetained', 'onlyNew']);
    });

    it('shows the allowance and the budget as about, before anything is subscribed', () => {
      const view = stripViewOf(
        viewOf(needsInitial, { store: NOT_CAPTURED, allowance: { remaining: 8_412, max: 10_000, budget: 4_206 } }),
        en
      );

      expect(view.detail).toBe(
        "Salesforce keeps up to 72 hours; each event counts against the org's daily delivery allocation (about 8,412 of 10,000 left); this run stops after about 4,206 deliveries and resumes on the next Start."
      );
    });

    it('drops the part of the allowance Salesforce did not report', () => {
      const detail = (allowance: CustomLogCaptureView['allowance']) =>
        stripViewOf(viewOf(needsInitial, { store: NOT_CAPTURED, allowance }), en).detail;

      expect(detail({ remaining: 8_412, budget: 4_206 })).toContain(
        'delivery allocation (about 8,412 left); this run stops after about 4,206 deliveries'
      );
      expect(detail({ budget: 5_000 })).toContain('delivery allocation; this run stops after about 5,000 deliveries');
      expect(detail(undefined)).toBe(
        "Salesforce keeps up to 72 hours; each event counts against the org's daily delivery allocation."
      );
    });

    it('writes the numbers the way the locale does', () => {
      const detail = stripViewOf(
        viewOf(needsInitial, { store: NOT_CAPTURED, allowance: { remaining: 8_412, max: 10_000, budget: 4_206 } }),
        contextFor('pt-br')
      ).detail;

      expect(detail).toContain('cerca de 8.412 de 10.000 restantes');
      expect(detail).toContain('cerca de 4.206 entregas');
    });
  });

  describe('failed', () => {
    it("shows core's message, which names the cause", () => {
      expect(stripViewOf(viewOf(STATES.failed), en).text).toBe('Capture failed: The cursor was rejected twice.');
    });

    it('explains the delivery limit instead of repeating the Salesforce error', () => {
      const view = stripViewOf(
        viewOf({
          state: 'failed',
          code: 'CUSTOM_LOG_DELIVERY_LIMIT',
          message: '403::Organization total events daily limit exceeded'
        }),
        en
      );

      expect(view.text).toBe(
        "Salesforce's daily event delivery limit is used up; capture resumes from the stored position later."
      );
    });
  });
});

describe('gap lines', () => {
  const gap = (fields: Partial<CustomLogStoreGapView>): CustomLogStoreGapView => ({
    reason: 'cursorRejected',
    detectedAt: '2026-10-28T08:00:01.002Z',
    ...fields
  });
  const lines = (gaps: CustomLogStoreGapView[], context = en) => gapLinesOf({ ...CAPTURED, gaps }, context);

  it('has none for a store without gaps or one never captured', () => {
    expect(lines([])).toEqual([]);
    expect(gapLinesOf(NOT_CAPTURED, en)).toEqual([]);
  });

  it('gives each reason its own wording', () => {
    const after = '2026-10-21T18:02:11.000Z';
    const before = '2026-10-25T09:40:02.554Z';
    const span = `between ${formatMinute(after)} and ${formatMinute(before)}`;

    expect(lines([gap({ reason: 'cursorRejected', after, before })])).toEqual([
      `Events ${span} may be missing (Salesforce rejected the stored position when capture resumed)`
    ]);
    expect(lines([gap({ reason: 'retentionElapsed', after, before })])).toEqual([
      `Events ${span} may be missing (the stored position was older than Salesforce keeps events)`
    ]);
    expect(lines([gap({ reason: 'orgChanged', after, before })])).toEqual([
      `Events ${span} may be missing (this username now points to another org)`
    ]);
  });

  it('reads an open gap as everything after its start', () => {
    expect(lines([gap({ after: '2026-10-21T18:02:11.000Z' })])).toEqual([
      `Events after ${formatMinute('2026-10-21T18:02:11.000Z')} may be missing (Salesforce rejected the stored position when capture resumed)`
    ]);
  });

  it('copes with a gap that names only its end or neither bound', () => {
    expect(lines([gap({ before: '2026-10-25T09:40:02.554Z' })])[0]).toMatch(
      /^Events before \d{4}-\d{2}-\d{2} \d{2}:\d{2} may be missing/
    );
    expect(lines([gap({})])).toEqual([
      'Some events may be missing (Salesforce rejected the stored position when capture resumed)'
    ]);
  });

  it('lists every gap in the order the store gives them', () => {
    const result = lines([gap({ reason: 'orgChanged' }), gap({ reason: 'retentionElapsed' })]);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain('another org');
    expect(result[1]).toContain('older than Salesforce keeps');
  });
});
