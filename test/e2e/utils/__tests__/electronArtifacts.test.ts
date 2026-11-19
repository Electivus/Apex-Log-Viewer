import { shouldKeepTrace, shouldRecordTrace } from '../electronArtifacts';

describe('electron trace modes', () => {
  test.each([
    ['off', 0, false],
    ['on', 0, true],
    ['retain-on-failure', 1, true],
    ['on-first-retry', 0, false],
    ['on-first-retry', 1, true],
    ['on-first-retry', 2, false],
    ['on-all-retries', 0, false],
    ['on-all-retries', 2, true],
    ['retain-on-first-failure', 0, true],
    ['retain-on-first-failure', 1, false],
    ['retain-on-failure-and-retries', 0, true],
    ['retain-on-failure-and-retries', 2, true],
    ['retry-with-trace', 0, false],
    ['retry-with-trace', 1, true]
  ])('records %s on retry %i: %s', (mode, retry, expected) => {
    expect(shouldRecordTrace(mode, retry)).toBe(expected);
  });

  test.each([
    ['on', false, 0, true],
    ['on-first-retry', false, 1, true],
    ['on-all-retries', false, 2, true],
    ['retain-on-failure', false, 0, false],
    ['retain-on-failure', true, 0, true],
    ['retain-on-first-failure', false, 0, false],
    ['retain-on-first-failure', true, 0, true],
    ['retain-on-first-failure', true, 1, false],
    ['retain-on-failure-and-retries', false, 0, false],
    ['retain-on-failure-and-retries', false, 1, true],
    ['retain-on-failure-and-retries', true, 0, true],
    ['retry-with-trace', false, 1, true],
    ['off', true, 0, false]
  ])('keeps %s (failed %s, retry %i): %s', (mode, failed, retry, expected) => {
    expect(shouldKeepTrace(mode, failed, retry)).toBe(expected);
  });
});
