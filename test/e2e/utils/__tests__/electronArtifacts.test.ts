import { shouldKeepTrace, shouldRecordTrace } from '../electronArtifacts';

describe('electron trace modes', () => {
  test('records a trace only when the mode asks for it on this attempt', () => {
    expect(shouldRecordTrace('off', 0)).toBe(false);
    expect(shouldRecordTrace('retain-on-failure', 0)).toBe(true);
    expect(shouldRecordTrace('on', 0)).toBe(true);
    expect(shouldRecordTrace('on-first-retry', 0)).toBe(false);
    expect(shouldRecordTrace('on-first-retry', 1)).toBe(true);
    expect(shouldRecordTrace('on-all-retries', 2)).toBe(true);
  });

  test('keeps a trace on failure for retain modes and always for on', () => {
    expect(shouldKeepTrace('retain-on-failure', false)).toBe(false);
    expect(shouldKeepTrace('retain-on-failure', true)).toBe(true);
    expect(shouldKeepTrace('on', false)).toBe(true);
    expect(shouldKeepTrace('off', true)).toBe(false);
  });
});
