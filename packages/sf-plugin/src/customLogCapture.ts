import { AlvError } from '@alv/core';
import type {
  CustomLogCaptureAllowance,
  CustomLogCaptureOutcome,
  CustomLogCaptureResult,
  CustomLogCaptureState,
  CustomLogCaptureUpdate,
  CustomLogRow,
  CustomLogStoreGap
} from '@alv/core/contracts';
import { SfError } from '@salesforce/core';

// What `capture --follow` prints: rows are the data and go to stdout, one line each, so a pipe sees
// nothing else; everything the person needs to know about the run goes to stderr.

const outcomeSentence = {
  quiet: 'Stopped: the stream went quiet.',
  timeLimit: 'Stopped: the time limit passed.',
  budget: 'Stopped: the delivery budget is spent. Run the command again to continue from the stored position.',
  aborted: 'Stopped.',
  capturedElsewhere: 'Not captured here: another process holds this source.',
  needsInitial: 'Nothing was captured: this project has no stored position yet.'
} as const satisfies Record<CustomLogCaptureOutcome, string>;

const catchUpSentence = {
  position: 'Catching up from the stored position.',
  retained: 'Replaying the events Salesforce still retains.',
  new: 'Waiting for new events.'
} as const satisfies Record<Extract<CustomLogCaptureState, { state: 'catchingUp' }>['from'], string>;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `2026-10-30T12:00:01.123Z ERROR integration@example.com Order sync failed`. A missing level or user prints `-`, so the columns keep their place. */
export function rowLine(row: CustomLogRow): string {
  return [row.time, row.level ?? '-', row.user ?? '-', oneLine(row.title ?? '')].join(' ').trimEnd();
}

/** The state as a sentence. `failed` prints nothing: the run rejects with the same code and message right after. */
export function stateLine(state: CustomLogCaptureState): string | undefined {
  switch (state.state) {
    case 'connecting':
      return 'Connecting.';
    case 'standby': {
      const { surface, pid, host } = state.holder;
      return `Another ${surface} process (pid ${pid} on ${host}) is capturing this source. Standing by; its rows print here.`;
    }
    case 'catchingUp':
      return catchUpSentence[state.from];
    case 'live':
      return state.basis === 'quiet'
        ? 'Live. The stream went quiet, so the backlog is probably done; Salesforce sends no end marker.'
        : 'Live.';
    case 'reconnecting':
      return `Reconnecting (attempt ${state.attempt}, cause: ${state.cause}).`;
    case 'stopped':
      return outcomeSentence[state.outcome];
    case 'failed':
      return undefined;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function allowanceLine(allowance: CustomLogCaptureAllowance): string {
  const stops = `This run stops after about ${allowance.budget} deliveries.`;
  return allowance.remaining === undefined || allowance.max === undefined
    ? stops
    : `The org has ${allowance.remaining} of ${allowance.max} daily event deliveries left. ${stops}`;
}

function spanOf(gap: CustomLogStoreGap): string {
  if (gap.after && gap.before) return `between ${gap.after} and ${gap.before}`;
  if (gap.after) return `after ${gap.after}`;
  if (gap.before) return `before ${gap.before}`;
  return 'at an unknown time';
}

export function gapLine(gap: CustomLogStoreGap): string {
  return `Events ${spanOf(gap)} may be missing (${gap.reason}).`;
}

/** The last lines of a `--follow` run: what it spent and stored, and every gap it created. */
export function finishLines(result: CustomLogCaptureResult): string[] {
  return [
    `Delivered ${result.delivered}, stored ${result.stored}. Store: ${result.store.eventsRoot}`,
    ...result.newGaps.map(gapLine)
  ];
}

/** Prints what changed since the previous update: a state line when the state differs, the allowance once, then the rows. */
export function updatePrinter(streams: { out: (line: string) => void; err: (line: string) => void }) {
  let lastState: string | undefined;
  let allowanceShown = false;
  return (update: CustomLogCaptureUpdate): void => {
    const state = stateLine(update.capture);
    if (state !== undefined && state !== lastState) {
      lastState = state;
      streams.err(state);
    }
    if (update.allowance && !allowanceShown) {
      allowanceShown = true;
      streams.err(allowanceLine(update.allowance));
    }
    for (const row of update.rows) streams.out(rowLine(row));
  };
}

/**
 * What to try next, for each code `capture` rejects with. Core's message says what happened (for the
 * transport codes it is the raw `403::...` text); this says what to do. Every one exits 1.
 */
const nextSteps = {
  INVALID_ARGUMENT: [],
  CUSTOM_LOG_SOURCE_NOT_FOUND: ['Run "sf electivus custom-log sources" to list the source ids.'],
  CUSTOM_LOG_NOT_EVENT_SOURCE: [
    'capture reads platform event sources. Read a record source with "sf electivus custom-log list".',
    'Run "sf electivus custom-log sources" and pick a source whose shape is events.'
  ],
  CUSTOM_LOG_SOURCE_UNAVAILABLE: ['Run "sf electivus custom-log sources" to see why this source is unavailable.'],
  CUSTOM_LOG_UNSUPPORTED_FILTER: ['Leave out --min-level or --user, or map that role in the source definition.'],
  CUSTOM_LOG_STORE_UNAVAILABLE: [
    'Run the command inside a Salesforce project, at or below the directory that holds sfdx-project.json.',
    'The message names the file or directory that cannot be used.'
  ],
  CUSTOM_LOG_DELIVERY_LIMIT: [
    'The org spent its daily platform event delivery allocation. Run the command again later: capture resumes from the stored position.'
  ],
  CUSTOM_LOG_CLIENT_LIMIT: [
    'The org has too many concurrent streaming clients. Close other subscribers, then run the command again.'
  ],
  CUSTOM_LOG_SUBSCRIBE_FORBIDDEN: [
    'The user needs Read access to the platform event object. Grant it with a permission set, or pass another --target-org.'
  ],
  CUSTOM_LOG_CAPTURE_FAILED: ['Run the command again: capture resumes from the stored position.']
} as const satisfies Record<string, readonly string[]>;

const isRejectionCode = (code: string): code is keyof typeof nextSteps => Object.hasOwn(nextSteps, code);

/** A rejection `capture` documents becomes an `SfError` named by its code, with next steps. Any other error passes through. */
export function withNextSteps(error: unknown): unknown {
  if (!(error instanceof AlvError) || !isRejectionCode(error.code)) return error;
  const steps = nextSteps[error.code];
  return new SfError(error.message, error.code, steps.length > 0 ? [...steps] : undefined, 1, error.cause);
}

/**
 * Runs `run` with a signal that Ctrl-C aborts, and that a closed stdout (`| head -1`) aborts too, so
 * the run still ends with its `aborted` result. `SfCommand` installs a SIGINT handler that exits 130
 * at once, which would skip that result, so this is the only SIGINT handler while `run` is pending.
 * A second Ctrl-C quits.
 */
export async function withInterrupt<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { onInterrupt?: () => void } = {}
): Promise<T> {
  const controller = new AbortController();
  const inherited = process.listeners('SIGINT');
  process.removeAllListeners('SIGINT');
  const quit = (): void => process.exit(130);
  const interrupted = (): void => {
    process.once('SIGINT', quit);
    options.onInterrupt?.();
    controller.abort();
  };
  const closed = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') controller.abort();
  };
  process.once('SIGINT', interrupted);
  process.stdout.on('error', closed);
  try {
    return await run(controller.signal);
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGINT', quit);
    process.stdout.removeListener('error', closed);
    for (const listener of inherited) process.on('SIGINT', listener);
  }
}
