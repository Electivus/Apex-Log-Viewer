import { parseLogLines } from '../utils/logViewerParser';
import { deriveLogSummary, describeLog, findPrimaryFailure } from '../utils/logViewerSummary';

const parse = (...lines: string[]) => parseLogLines(lines);

describe('findPrimaryFailure', () => {
  it('returns nothing for a clean log', () => {
    const entries = parse(
      '65.0 APEX_CODE,DEBUG',
      '12:00:00.0 (1000)|EXECUTION_STARTED',
      '12:00:00.0 (2000)|USER_DEBUG|[1]|DEBUG|n=3',
      '12:00:00.0 (3000)|EXECUTION_FINISHED'
    );
    expect(findPrimaryFailure(entries)).toBeUndefined();
  });

  it('prefers FATAL_ERROR over an earlier EXCEPTION_THROWN and takes the line from the stack trace', () => {
    const entries = parse(
      '12:00:00.0 (1000)|EXCEPTION_THROWN|[5]|System.MathException: Divide by 0',
      '12:00:00.0 (2000)|FATAL_ERROR|System.MathException: Divide by 0',
      '',
      'AnonymousBlock: line 5, column 1',
      '12:00:00.0 (3000)|CODE_UNIT_FINISHED|execute_anonymous_apex'
    );
    expect(findPrimaryFailure(entries)).toEqual({
      message: 'System.MathException: Divide by 0',
      lineNumber: 5,
      entryId: 1,
      type: 'FATAL_ERROR'
    });
  });

  it('does not borrow a line from the next timestamped event', () => {
    const entries = parse(
      '12:00:00.0 (2000)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object',
      '12:00:00.0 (3000)|USER_DEBUG|[9]|DEBUG|line 9'
    );
    expect(findPrimaryFailure(entries)?.lineNumber).toBeUndefined();
  });

  it('uses EXCEPTION_THROWN when the log has no FATAL_ERROR', () => {
    const entries = parse(
      '12:00:00.0 (1000)|VALIDATION_ERROR|Required fields are missing',
      '12:00:00.0 (2000)|EXCEPTION_THROWN|[7]|System.DmlException: Insert failed'
    );
    expect(findPrimaryFailure(entries)).toMatchObject({ type: 'EXCEPTION_THROWN', lineNumber: 7, entryId: 1 });
  });

  it('falls back to any other error entry', () => {
    const entries = parse(
      '12:00:00.0 (1000)|EXECUTION_STARTED',
      '12:00:00.0 (2000)|VALIDATION_ERROR|Required fields are missing'
    );
    expect(findPrimaryFailure(entries)).toMatchObject({
      type: 'VALIDATION_ERROR',
      message: 'Required fields are missing',
      entryId: 1
    });
  });

  it('names the event when an error entry has no message', () => {
    expect(findPrimaryFailure(parse('12:00:00.0 (2000)|FATAL_ERROR'))?.message).toBe('FATAL_ERROR');
  });
});

describe('deriveLogSummary', () => {
  it('reads the user, entry point, duration and start from the log', () => {
    const entries = parse(
      '65.0 APEX_CODE,DEBUG',
      '14:03:21.5 (1000000)|EXECUTION_STARTED',
      '14:03:21.5 (2000000)|USER_INFO|[EXTERNAL]|005Hs00000AbCdE|ana@example.com.sandbox|Pacific Standard Time|GMT-08:00',
      '14:03:21.5 (3000000)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
      '14:03:21.9 (185000000)|CODE_UNIT_FINISHED|execute_anonymous_apex'
    );
    expect(deriveLogSummary(entries)).toEqual({
      entryPoint: 'execute_anonymous_apex',
      username: 'ana@example.com.sandbox',
      durationMs: 184,
      startedAt: '14:03:21'
    });
  });

  it('names a class method entry point and skips the record id', () => {
    const entries = parse('12:00:00.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01p4x00000AbCdE|InvoiceService.run()');
    expect(deriveLogSummary(entries).entryPoint).toBe('InvoiceService.run()');
  });

  it('keeps the trigger description rather than its source path', () => {
    const entries = parse(
      '12:00:00.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01q4x00000AbCdE|AccountTrigger on Account trigger event BeforeInsert|__sfdc_trigger/AccountTrigger'
    );
    expect(deriveLogSummary(entries).entryPoint).toBe('AccountTrigger on Account trigger event BeforeInsert');
  });

  it('omits what the log does not say', () => {
    expect(deriveLogSummary(parse('65.0 APEX_CODE,DEBUG'))).toEqual({});
    expect(deriveLogSummary([])).toEqual({});
  });

  it('needs two elapsed values for a duration', () => {
    expect(deriveLogSummary(parse('12:00:00.0 (5000)|EXECUTION_STARTED')).durationMs).toBeUndefined();
  });
});

describe('describeLog', () => {
  const summary = {
    entryPoint: 'execute_anonymous_apex',
    username: 'ana@example.com',
    durationMs: 184,
    startedAt: '14:03:21'
  };

  it('titles the log with its entry point and lists the rest as detail', () => {
    expect(describeLog(summary, '07L000000000001.log')).toEqual({
      title: 'execute_anonymous_apex',
      details: ['ana@example.com', '184 ms', '14:03:21', '07L000000000001.log']
    });
  });

  it('skips missing parts', () => {
    expect(describeLog({ entryPoint: 'Foo.bar()', durationMs: 2500 }, '')).toEqual({
      title: 'Foo.bar()',
      details: ['2.5 s']
    });
  });

  it('falls back to the file name without repeating it', () => {
    expect(describeLog({ username: 'ana@example.com' }, '07L1.log')).toEqual({
      title: '07L1.log',
      details: ['ana@example.com']
    });
    expect(describeLog({}, '')).toEqual({ title: undefined, details: [] });
  });
});
