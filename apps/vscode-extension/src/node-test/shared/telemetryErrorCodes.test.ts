import assert from 'assert/strict';
import { getTelemetryErrorCode } from '../../shared/telemetryErrorCodes';

suite('telemetry error codes', () => {
  test('classifies runtime exits before low-level stream codes', () => {
    const error = new Error('runtime exited (code 1)') as Error & { code?: string };
    error.code = 'EPIPE';

    assert.equal(getTelemetryErrorCode(error), 'RUNTIME_EXIT');
  });

  test('normalizes known timeout and auth failures', () => {
    assert.equal(
      getTelemetryErrorCode(Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' })),
      'ETIMEDOUT'
    );
    assert.equal(getTelemetryErrorCode(new Error('Salesforce auth failed: invalid grant')), 'AUTH_FAILED');
  });

  test('keeps generic not-found messages out of CLI install buckets', () => {
    assert.equal(getTelemetryErrorCode(new Error('Trace flag target was not found')), 'UNKNOWN');
    assert.equal(
      getTelemetryErrorCode(new Error('Salesforce CLI not found. Install Salesforce CLI (sf).')),
      'CLI_NOT_FOUND'
    );
    assert.equal(getTelemetryErrorCode(new Error('runtime executable failed to start')), 'RUNTIME_START_FAILED');
  });
});
