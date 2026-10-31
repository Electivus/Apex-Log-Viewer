import type {
  CustomLogCaptureOutcomeView,
  CustomLogCaptureView,
  CustomLogStoreGapView,
  CustomLogStoreView
} from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { formatBytes } from '../format';
import { fillTemplate, formatCount, formatMinute } from './format';

export type StripAction = 'stop' | 'start' | 'loadRetained' | 'onlyNew';
export type StripTone = 'busy' | 'live' | 'idle' | 'attention';

/** What the capture strip shows for one `CustomLogCaptureView`, as text and the actions that make sense in it. */
export type StripView = {
  tone: StripTone;
  /** A short word before the text, like "Live". It carries `hint` as its tooltip. */
  label?: string;
  hint?: string;
  text: string;
  /** A second line: the first-use explanation, or what to do when the lease holder is gone. */
  detail?: string;
  actions: readonly StripAction[];
};

export type StripContext = {
  t: CustomLogsMessages;
  locale: string;
  /** The selected source's label, for the sentence that names what is being connected. */
  sourceLabel: string;
};

const DELIVERY_LIMIT_CODE = 'CUSTOM_LOG_DELIVERY_LIMIT';

function storedText(store: CustomLogStoreView, { t }: StripContext): string {
  switch (store.state) {
    case 'notCaptured':
      return t.capture.nothingStored;
    case 'captured':
      return store.oldest
        ? [
            fillTemplate(t.capture.storedSince, { since: formatMinute(store.oldest) }),
            formatBytes(store.sizeBytes)
          ].join(' · ')
        : t.capture.nothingStored;
  }
}

function leaseNote(store: CustomLogStoreView, { t }: StripContext): string {
  return fillTemplate(t.capture.leaseNote, { folder: store.eventsRoot });
}

/** "(about 8,412 of 10,000 left)", or nothing when Salesforce did not say. */
function leftText(allowance: NonNullable<CustomLogCaptureView['allowance']>, { t, locale }: StripContext): string {
  if (allowance.remaining === undefined) {
    return '';
  }
  return allowance.max === undefined
    ? fillTemplate(t.capture.firstUse.leftOnly, { remaining: formatCount(allowance.remaining, locale) })
    : fillTemplate(t.capture.firstUse.left, {
        remaining: formatCount(allowance.remaining, locale),
        max: formatCount(allowance.max, locale)
      });
}

function firstUseNote(allowance: CustomLogCaptureView['allowance'], context: StripContext): string {
  const { t, locale } = context;
  return allowance
    ? fillTemplate(t.capture.firstUse.note, {
        left: leftText(allowance, context),
        budget: formatCount(allowance.budget, locale)
      })
    : t.capture.firstUse.noteNoBudget;
}

function stoppedView(
  outcome: CustomLogCaptureOutcomeView,
  { store, allowance }: CustomLogCaptureView,
  context: StripContext
): StripView {
  const { t, locale } = context;
  switch (outcome) {
    case 'quiet':
    case 'timeLimit':
    case 'aborted':
      return { tone: 'idle', label: t.capture.stopped, text: storedText(store, context), actions: ['start'] };
    case 'budget':
      return {
        tone: 'attention',
        text: allowance
          ? fillTemplate(t.capture.budget, { budget: formatCount(allowance.budget, locale) })
          : t.capture.budgetNoAllowance,
        actions: ['start']
      };
    case 'capturedElsewhere':
      return {
        tone: 'attention',
        text: t.capture.elsewhere,
        detail: leaseNote(store, context),
        actions: ['start']
      };
    case 'needsInitial':
      return {
        tone: 'idle',
        text: t.capture.firstUse.empty,
        detail: firstUseNote(allowance, context),
        actions: ['loadRetained', 'onlyNew']
      };
  }
}

/** One switch over the capture state: a state core adds and this file misses fails the build here. */
export function stripViewOf(view: CustomLogCaptureView, context: StripContext): StripView {
  const { t } = context;
  const { capture, store, wanted } = view;
  const stop: readonly StripAction[] = wanted ? ['stop'] : [];
  switch (capture.state) {
    case 'connecting':
      return {
        tone: 'busy',
        text: fillTemplate(t.capture.connecting, { source: context.sourceLabel }),
        actions: stop
      };
    case 'standby':
      return {
        tone: 'idle',
        text: fillTemplate(t.capture.standby, {
          surface: t.capture.surface[capture.holder.surface],
          pid: capture.holder.pid,
          host: capture.holder.host
        }),
        detail: leaseNote(store, context),
        actions: stop
      };
    case 'catchingUp':
      return {
        tone: 'busy',
        text: catchingUpText(capture.from, store, context),
        actions: stop
      };
    case 'live':
      return {
        tone: 'live',
        label: t.capture.live,
        ...(capture.basis === 'quiet' ? { hint: t.capture.liveHint } : {}),
        text: storedText(store, context),
        actions: stop
      };
    case 'reconnecting':
      return {
        tone: 'busy',
        text: fillTemplate(t.capture.reconnecting, {
          attempt: capture.attempt,
          cause: t.capture.reconnectCause[capture.cause]
        }),
        actions: stop
      };
    case 'stopped':
      return stoppedView(capture.outcome, view, context);
    case 'failed':
      return {
        tone: 'attention',
        text:
          capture.code === DELIVERY_LIMIT_CODE
            ? t.capture.deliveryLimit
            : fillTemplate(t.capture.failed, { message: capture.message }),
        actions: ['start']
      };
  }
}

function catchingUpText(from: 'position' | 'retained' | 'new', store: CustomLogStoreView, { t }: StripContext): string {
  switch (from) {
    case 'position':
      return store.state === 'captured'
        ? fillTemplate(t.capture.catchingUpPosition, { since: formatMinute(store.lastCaptureAt) })
        : t.capture.catchingUpRetained;
    case 'retained':
      return t.capture.catchingUpRetained;
    case 'new':
      return t.capture.catchingUpNew;
  }
}

function gapLine(gap: CustomLogStoreGapView, { t }: StripContext): string {
  const reason = t.capture.gaps.reasons[gap.reason];
  const after = gap.after ? formatMinute(gap.after) : undefined;
  const before = gap.before ? formatMinute(gap.before) : undefined;
  if (after && before) {
    return fillTemplate(t.capture.gaps.between, { after, before, reason });
  }
  if (after) {
    return fillTemplate(t.capture.gaps.after, { after, reason });
  }
  if (before) {
    return fillTemplate(t.capture.gaps.before, { before, reason });
  }
  return fillTemplate(t.capture.gaps.unknown, { reason });
}

/** One sentence per gap the store holds, open or closed. A store that was never captured has none. */
export function gapLinesOf(store: CustomLogStoreView, context: StripContext): string[] {
  switch (store.state) {
    case 'notCaptured':
      return [];
    case 'captured':
      return store.gaps.map(gap => gapLine(gap, context));
  }
}
