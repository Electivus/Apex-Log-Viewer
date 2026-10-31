import assert from 'node:assert/strict';
import test from 'node:test';

import type { CustomLogCaptureState } from '../src/customLogs/contracts.ts';
import {
  BUDGET_FALLBACK,
  CONFIRM_LAG_MS,
  DRAIN_DEFAULT_MS,
  FIRST_EVENT_WAIT_MS,
  PLATFORM_RETENTION_MS,
  RECONNECT_BACKOFF_MS,
  backoffMs,
  chooseStart,
  closesGap,
  coveredUntilMs,
  deliveryBudget,
  drainBoundOutcome,
  firstEventWait,
  nextState,
  proofOnAck,
  proofOnDown,
  proofOnLive,
  type StateInput,
  type TipProof
} from '../src/customLogs/events/captureRules.ts';
import { cometdCursor, parseEventUuid, type EventUuid } from '../src/customLogs/events/ids.ts';

const HOUR = 3_600_000;
const NOW = new Date('2026-10-30T12:00:00.000Z');
const ORG = '00D000000000001AAA';
const OTHER_ORG = '00D000000000002AAA';
const uuid = parseEventUuid('00000000-0000-4000-8000-000000000001') as EventUuid;
const LAST_EVENT = { createdDate: '2026-10-30T09:00:00.000Z', uuid };
const CURSOR = cometdCursor(1_001);

const checkpoint = (overrides: { orgId?: string; transport?: 'cometd' | 'pubsub'; ageMs?: number } = {}) => ({
  orgId: overrides.orgId ?? ORG,
  transport: overrides.transport ?? ('cometd' as const),
  cursor: CURSOR,
  lastEvent: LAST_EVENT,
  updatedAt: new Date(NOW.getTime() - (overrides.ageMs ?? 0)).toISOString()
});

const AFTER = { kind: 'after', position: { cursor: CURSOR, lastEvent: LAST_EVENT } } as const;

/** A checkpoint whose last event is older than retention, so only `coveredUntil` can spare the gap. */
const OLD_EVENT = { createdDate: '2026-10-20T00:00:00.000Z', uuid };
const oldCheckpoint = (overrides: { coveredUntil?: string }) => ({
  ...checkpoint(),
  lastEvent: OLD_EVENT,
  ...(overrides.coveredUntil !== undefined ? { coveredUntil: overrides.coveredUntil } : {})
});
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/** What the store covers decides the retention gap: max(last event, coveredUntil). `updatedAt` (always fresh here) does not count. */
const coverageCases: [label: string, overrides: Parameters<typeof oldCheckpoint>[0], gap: boolean][] = [
  ['an old last event with no proven coverage raises the gap, however fresh updatedAt is', {}, true],
  ['coverage proven inside the window raises no gap', { coveredUntil: ago(PLATFORM_RETENTION_MS - 1) }, false],
  ['coverage proven exactly at the window is not elapsed', { coveredUntil: ago(PLATFORM_RETENTION_MS) }, false],
  ['coverage proven before the window raises the gap', { coveredUntil: ago(PLATFORM_RETENTION_MS + 1) }, true],
  ['an unreadable coveredUntil proves nothing', { coveredUntil: 'not a date' }, true]
];

type StartCase = [label: string, input: Parameters<typeof chooseStart>[0], expected: ReturnType<typeof chooseStart>];

const startCases: StartCase[] = [
  [
    'no checkpoint, retained',
    { checkpoint: undefined, orgId: ORG, transport: 'cometd', initial: 'retained', now: NOW },
    { kind: 'subscribe', start: { kind: 'retained' } }
  ],
  [
    'no checkpoint, new',
    { checkpoint: undefined, orgId: ORG, transport: 'cometd', initial: 'new', now: NOW },
    { kind: 'subscribe', start: { kind: 'new' } }
  ],
  [
    'no checkpoint, none',
    { checkpoint: undefined, orgId: ORG, transport: 'cometd', initial: 'none', now: NOW },
    { kind: 'needsInitial' }
  ],
  [
    'a fresh checkpoint resumes after its cursor whatever initial says',
    { checkpoint: checkpoint(), orgId: ORG, transport: 'cometd', initial: 'none', now: NOW },
    { kind: 'subscribe', start: AFTER }
  ],
  [
    'another org id: orgChanged gap, then as no checkpoint (retained)',
    { checkpoint: checkpoint({ orgId: OTHER_ORG }), orgId: ORG, transport: 'cometd', initial: 'retained', now: NOW },
    { kind: 'subscribe', start: { kind: 'retained' }, gap: { reason: 'orgChanged', after: LAST_EVENT.createdDate } }
  ],
  [
    'another org id and initial new',
    { checkpoint: checkpoint({ orgId: OTHER_ORG }), orgId: ORG, transport: 'cometd', initial: 'new', now: NOW },
    { kind: 'subscribe', start: { kind: 'new' }, gap: { reason: 'orgChanged', after: LAST_EVENT.createdDate } }
  ],
  [
    'another org id and initial none still records the gap',
    { checkpoint: checkpoint({ orgId: OTHER_ORG }), orgId: ORG, transport: 'cometd', initial: 'none', now: NOW },
    { kind: 'needsInitial', gap: { reason: 'orgChanged', after: LAST_EVENT.createdDate } }
  ],
  [
    'another transport: retained, no gap',
    { checkpoint: checkpoint({ transport: 'pubsub' }), orgId: ORG, transport: 'cometd', initial: 'none', now: NOW },
    { kind: 'subscribe', start: { kind: 'retained' } }
  ],
  [
    'the org check comes before the transport check',
    {
      checkpoint: checkpoint({ orgId: OTHER_ORG, transport: 'pubsub' }),
      orgId: ORG,
      transport: 'cometd',
      initial: 'retained',
      now: NOW
    },
    { kind: 'subscribe', start: { kind: 'retained' }, gap: { reason: 'orgChanged', after: LAST_EVENT.createdDate } }
  ],
  ...coverageCases.map(([label, overrides, gap]): StartCase => [
    label,
    { checkpoint: oldCheckpoint(overrides), orgId: ORG, transport: 'cometd', initial: 'retained', now: NOW },
    {
      kind: 'subscribe',
      start: { kind: 'after', position: { cursor: CURSOR, lastEvent: OLD_EVENT } },
      ...(gap ? { gap: { reason: 'retentionElapsed', after: OLD_EVENT.createdDate } } : {})
    }
  ])
];

for (const [label, input, expected] of startCases) {
  test(`chooseStart: ${label}`, () => {
    assert.deepEqual(chooseStart(input), expected);
  });
}

test('deliveryBudget: about half of what remains, the fallback when /limits is unknown, never negative', () => {
  assert.equal(deliveryBudget({ remaining: 8_412, max: 10_000 }), 4_206);
  assert.equal(deliveryBudget({ remaining: 25_001, max: 50_000 }), 12_500);
  assert.equal(deliveryBudget({ remaining: 1, max: 10_000 }), 0);
  assert.equal(deliveryBudget({ remaining: -5, max: 10_000 }), 0);
  assert.equal(deliveryBudget(undefined), BUDGET_FALLBACK);
});

test('backoffMs: grows with the attempt, repeats the last step, and treats 0 as the first attempt', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 100].map(backoffMs), [
    ...RECONNECT_BACKOFF_MS,
    RECONNECT_BACKOFF_MS[5],
    RECONNECT_BACKOFF_MS[5]
  ]);
  assert.equal(backoffMs(0), RECONNECT_BACKOFF_MS[0]);
});

const ageOf = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

type WaitCase = [
  label: string,
  input: Parameters<typeof firstEventWait>[0],
  expected: ReturnType<typeof firstEventWait>
];

const waitCases: WaitCase[] = [
  [
    'new, drain',
    { from: 'new', checkpointUpdatedAt: undefined, follow: false, now: NOW },
    { kind: 'timer', ms: FIRST_EVENT_WAIT_MS }
  ],
  [
    'new, follow',
    { from: 'new', checkpointUpdatedAt: undefined, follow: true, now: NOW },
    { kind: 'timer', ms: FIRST_EVENT_WAIT_MS }
  ],
  [
    'after, 59 min old, drain',
    { from: 'after', checkpointUpdatedAt: ageOf(59), follow: false, now: NOW },
    { kind: 'timer', ms: FIRST_EVENT_WAIT_MS }
  ],
  [
    'after, 61 min old, drain',
    { from: 'after', checkpointUpdatedAt: ageOf(61), follow: false, now: NOW },
    { kind: 'drainBound' }
  ],
  [
    'after, 61 min old, follow',
    { from: 'after', checkpointUpdatedAt: ageOf(61), follow: true, now: NOW },
    { kind: 'timer', ms: DRAIN_DEFAULT_MS }
  ],
  [
    'retained, drain',
    { from: 'retained', checkpointUpdatedAt: undefined, follow: false, now: NOW },
    { kind: 'drainBound' }
  ],
  [
    'retained, follow',
    { from: 'retained', checkpointUpdatedAt: undefined, follow: true, now: NOW },
    { kind: 'timer', ms: DRAIN_DEFAULT_MS }
  ],
  [
    'after, unreadable updatedAt, drain',
    { from: 'after', checkpointUpdatedAt: 'not a date', follow: false, now: NOW },
    { kind: 'drainBound' }
  ],
  [
    'after, no updatedAt, follow',
    { from: 'after', checkpointUpdatedAt: undefined, follow: true, now: NOW },
    { kind: 'timer', ms: DRAIN_DEFAULT_MS }
  ]
];

for (const [label, input, expected] of waitCases) {
  test(`firstEventWait: ${label}`, () => {
    assert.deepEqual(firstEventWait(input), expected);
  });
}

const DRAIN_BOUND = { kind: 'drainBound' } as const;
const FIFTEEN = { kind: 'timer', ms: FIRST_EVENT_WAIT_MS } as const;

type OutcomeCase = [
  label: string,
  input: Parameters<typeof drainBoundOutcome>[0],
  expected: ReturnType<typeof drainBoundOutcome>
];

const outcomeCases: OutcomeCase[] = [
  [
    'up, no event since the ack: the wait expired, so live then quiet',
    { wait: DRAIN_BOUND, transportUp: true, deliveredSinceAck: 0 },
    { enterLive: true, outcome: 'quiet' }
  ],
  [
    'up, an event since the ack: still catching up',
    { wait: DRAIN_BOUND, transportUp: true, deliveredSinceAck: 5 },
    { enterLive: false, outcome: 'timeLimit' }
  ],
  [
    'not up (before the ack or reconnecting)',
    { wait: DRAIN_BOUND, transportUp: false, deliveredSinceAck: 0 },
    { enterLive: false, outcome: 'timeLimit' }
  ],
  [
    'not up and events since an earlier ack',
    { wait: DRAIN_BOUND, transportUp: false, deliveredSinceAck: 3 },
    { enterLive: false, outcome: 'timeLimit' }
  ],
  [
    'a timer wait the bound outran (young cursor, --max-time under 15 s)',
    { wait: FIFTEEN, transportUp: true, deliveredSinceAck: 0 },
    { enterLive: false, outcome: 'timeLimit' }
  ]
];

for (const [label, input, expected] of outcomeCases) {
  test(`drainBoundOutcome: ${label}`, () => {
    assert.deepEqual(drainBoundOutcome(input), expected);
  });
}

const HOLDER = { surface: 'vscode', pid: 4_242, host: 'laptop', since: '2026-10-30T10:00:00.000Z' } as const;
const states = {
  connecting: { state: 'connecting' },
  standby: { state: 'standby', holder: HOLDER },
  catchingUp: { state: 'catchingUp', from: 'retained' },
  live: { state: 'live', basis: 'quiet' },
  reconnectingTransport: { state: 'reconnecting', attempt: 1, cause: 'transport' },
  reconnectingAuth: { state: 'reconnecting', attempt: 2, cause: 'auth' },
  stopped: { state: 'stopped', outcome: 'quiet' },
  failed: { state: 'failed', code: 'CUSTOM_LOG_CAPTURE_FAILED', message: 'x' }
} as const satisfies Record<string, CustomLogCaptureState>;

type StateCase = [from: keyof typeof states, input: StateInput, expected: CustomLogCaptureState | 'same'];

const stateCases: StateCase[] = [
  ['connecting', { type: 'subscribed', from: 'new' }, { state: 'catchingUp', from: 'new' }],
  ['connecting', { type: 'subscribed', from: 'after' }, { state: 'catchingUp', from: 'position' }],
  ['connecting', { type: 'subscribed', from: 'retained' }, { state: 'catchingUp', from: 'retained' }],
  ['connecting', { type: 'up' }, 'same'],
  ['connecting', { type: 'down' }, 'same'],
  ['connecting', { type: 'quiet' }, 'same'],
  ['connecting', { type: 'connecting' }, 'same'],
  ['standby', { type: 'connecting' }, { state: 'connecting' }],
  ['standby', { type: 'standby', holder: HOLDER }, 'same'],
  ['standby', { type: 'standby', holder: { ...HOLDER, pid: 1 } }, { state: 'standby', holder: { ...HOLDER, pid: 1 } }],
  ['connecting', { type: 'standby', holder: HOLDER }, { state: 'standby', holder: HOLDER }],
  ['catchingUp', { type: 'quiet' }, { state: 'live', basis: 'quiet' }],
  ['live', { type: 'quiet' }, 'same'],
  ['catchingUp', { type: 'down' }, { state: 'reconnecting', attempt: 1, cause: 'transport' }],
  ['live', { type: 'down' }, { state: 'reconnecting', attempt: 1, cause: 'transport' }],
  ['reconnectingTransport', { type: 'down' }, 'same'],
  ['reconnectingTransport', { type: 'up' }, { state: 'catchingUp', from: 'position' }],
  ['reconnectingAuth', { type: 'up' }, 'same'],
  ['live', { type: 'up' }, 'same'],
  ['live', { type: 'subscribed', from: 'after' }, { state: 'catchingUp', from: 'position' }],
  ['reconnectingAuth', { type: 'subscribed', from: 'after' }, { state: 'catchingUp', from: 'position' }],
  [
    'live',
    { type: 'reconnecting', attempt: 3, cause: 'overflow' },
    { state: 'reconnecting', attempt: 3, cause: 'overflow' }
  ],
  ['live', { type: 'stopped', outcome: 'aborted' }, { state: 'stopped', outcome: 'aborted' }],
  [
    'catchingUp',
    { type: 'failed', code: 'CUSTOM_LOG_DELIVERY_LIMIT', message: 'limit' },
    { state: 'failed', code: 'CUSTOM_LOG_DELIVERY_LIMIT', message: 'limit' }
  ],
  ['stopped', { type: 'subscribed', from: 'new' }, 'same'],
  ['stopped', { type: 'failed', code: 'CUSTOM_LOG_CAPTURE_FAILED', message: 'late' }, 'same'],
  ['failed', { type: 'stopped', outcome: 'aborted' }, 'same'],
  ['failed', { type: 'connecting' }, 'same']
];

for (const [from, input, expected] of stateCases) {
  test(`nextState: ${from} + ${input.type}${'from' in input ? `(${input.from})` : ''}`, () => {
    const current: CustomLogCaptureState = states[from];
    const next = nextState(current, input);
    if (expected === 'same') assert.equal(next, current, 'a no-op returns the current state itself');
    else assert.deepEqual(next, expected);
  });
}

test('closesGap: any stored event closes a gap with no bound; otherwise only an event newer than `after`', () => {
  const at = (createdDate: string) => ({ createdDate, uuid });
  assert.equal(closesGap({}, at('2026-10-30T09:00:00.000Z')), true);
  assert.equal(closesGap({ after: '2026-10-30T09:00:00.000Z' }, at('2026-10-30T09:00:00.001Z')), true);
  assert.equal(closesGap({ after: '2026-10-30T09:00:00.000Z' }, at('2026-10-30T09:00:00.000Z')), false);
  assert.equal(closesGap({ after: '2026-10-30T09:00:00.000Z' }, at('2026-10-30T08:59:59.999Z')), false);
});

// ---------------------------------------------------------------------------------------------
// tip proof

const T = NOW.getTime();
const proofSteps: [label: string, steps: (proof: TipProof) => TipProof, atMs: number, coveredMs: number | undefined][] =
  [
    ['nothing proven', proof => proof, T, undefined],
    ['carried coverage stays', () => ({ coveredMs: T - 1_000 }), T, T - 1_000],
    [
      'a `new` acknowledgement proves the tip at once',
      proof => proofOnAck(proof, 'new', T),
      T + HOUR,
      T + HOUR - CONFIRM_LAG_MS
    ],
    [
      'silence for the first-event wait after an `after` acknowledgement proves it from the acknowledgement',
      proof => proofOnLive(proofOnAck(proof, 'after', T), 0, T + FIRST_EVENT_WAIT_MS),
      T + FIRST_EVENT_WAIT_MS,
      T
    ],
    [
      'a shorter silence proves nothing',
      proof => proofOnLive(proofOnAck(proof, 'after', T), 0, T + FIRST_EVENT_WAIT_MS - 1),
      T + HOUR,
      undefined
    ],
    [
      'events since the acknowledgement prove nothing',
      proof => proofOnLive(proofOnAck(proof, 'retained', T), 1, T + HOUR),
      T + 2 * HOUR,
      undefined
    ],
    [
      'a drop keeps what was proven until then and nothing after',
      proof => proofOnLive(proofOnDown(proofOnAck(proof, 'new', T), T + HOUR), 0, T + 3 * HOUR),
      T + 4 * HOUR,
      T + HOUR - CONFIRM_LAG_MS
    ]
  ];

for (const [label, steps, atMs, coveredMs] of proofSteps) {
  test(`tip proof: ${label}`, () => {
    assert.equal(coveredUntilMs(steps({}), atMs), coveredMs);
  });
}
