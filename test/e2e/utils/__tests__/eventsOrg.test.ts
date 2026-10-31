import {
  EVENT_OBJECTS,
  EVENT_SOURCE_ID,
  cursorAhead,
  daysAgo,
  deliveredBy,
  eventSourceDefinition,
  lastJsonLine,
  type CliOutcome
} from '../eventsOrg';

const outcome = (parts: Partial<CliOutcome>): CliOutcome => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
  ...parts
});

describe('lastJsonLine', () => {
  test('takes the last JSON line and ignores progress text around it', () => {
    const stdout = ['connecting', '{"published":1}', 'noise', '{"published":25,"runTag":"abc123"}', ''].join('\n');
    expect(lastJsonLine(stdout)).toEqual({ published: 25, runTag: 'abc123' });
  });

  test('names the output it could not parse', () => {
    expect(() => lastJsonLine('no json here')).toThrow(/No JSON line in output: no json here/);
  });
});

describe('deliveredBy', () => {
  test('reads the delivered count of a JSON result', () => {
    expect(deliveredBy(outcome({ json: { result: { delivered: 30, stored: 30 } } }))).toBe(30);
  });

  test('reads the Delivered line a --follow run prints to stderr', () => {
    expect(
      deliveredBy(outcome({ stderr: 'Live.\nDelivered 50, stored 48. Store: /tmp/apexlogs/orgs/u/events/X__e\n' }))
    ).toBe(50);
  });

  test('counts a command that reports nothing as zero deliveries', () => {
    expect(deliveredBy(outcome({ json: { name: 'CUSTOM_LOG_SOURCE_UNAVAILABLE' } }))).toBe(0);
    expect(deliveredBy(outcome({}))).toBe(0);
  });
});

describe('cursorAhead', () => {
  test('moves a replay cursor past anything the bus has reached, in the same transport', () => {
    expect(cursorAhead('cometd:1626120')).toBe('cometd:2626120');
    expect(cursorAhead('cometd:5', 10)).toBe('cometd:15');
  });
});

describe('daysAgo', () => {
  test('is an ISO instant that many whole days before now', () => {
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    expect(daysAgo(4, now)).toBe('2026-10-27T12:00:00.000Z');
  });
});

describe('eventSourceDefinition', () => {
  test('maps the six roles every ALV event has and leaves Request_Id__c and Payload__c unmapped', () => {
    const definition = eventSourceDefinition({ object: EVENT_OBJECTS.replay });
    expect(definition.id).toBe(EVENT_SOURCE_ID);
    expect(definition.event.object).toBe('ALV_Test_Replay__e');
    expect(Object.keys(definition.event.fields).sort()).toEqual([
      'level',
      'message',
      'order',
      'time',
      'transactionId',
      'user'
    ]);
    expect(JSON.stringify(definition)).not.toMatch(/Request_Id__c|Payload__c/);
  });

  test('adds what a scenario asks for on top', () => {
    const definition = eventSourceDefinition({ object: EVENT_OBJECTS.log, extraEvent: { columns: ['Request_Id__c'] } });
    expect(definition.event).toMatchObject({ object: 'ALV_Test_Log__e', columns: ['Request_Id__c'] });
  });
});
