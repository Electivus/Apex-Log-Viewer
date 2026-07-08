import { resolvePlaywrightParallelism, resolvePlaywrightTimeouts } from '../playwrightParallelism';

describe('resolvePlaywrightParallelism', () => {
  test('enables full parallelism and respects workers for explicit pool mode', () => {
    expect(
      resolvePlaywrightParallelism({
        SF_SCRATCH_STRATEGY: 'pool',
        PLAYWRIGHT_WORKERS: '4'
      })
    ).toEqual({
      fullyParallel: true,
      workers: 4
    });
  });

  test('auto-detects pool mode from SF_SCRATCH_POOL_NAME', () => {
    expect(
      resolvePlaywrightParallelism({
        SF_SCRATCH_POOL_NAME: 'alv-e2e',
        PLAYWRIGHT_WORKERS: '3'
      })
    ).toEqual({
      fullyParallel: true,
      workers: 3
    });
  });

  test('forces serial execution for explicit single mode', () => {
    expect(
      resolvePlaywrightParallelism({
        SF_SCRATCH_STRATEGY: 'single',
        SF_SCRATCH_POOL_NAME: 'alv-e2e',
        PLAYWRIGHT_WORKERS: '5'
      })
    ).toEqual({
      fullyParallel: false,
      workers: 1
    });
  });

  test.each(['', '0', '-1', 'abc', '2.5'])('falls back to one worker for invalid PLAYWRIGHT_WORKERS=%p', workers => {
    expect(
      resolvePlaywrightParallelism({
        SF_SCRATCH_STRATEGY: 'pool',
        PLAYWRIGHT_WORKERS: workers
      })
    ).toEqual({
      fullyParallel: true,
      workers: 1
    });
  });

  test('rejects invalid scratch strategies', () => {
    expect(() =>
      resolvePlaywrightParallelism({
        SF_SCRATCH_STRATEGY: 'parallel'
      })
    ).toThrow("Invalid SF_SCRATCH_STRATEGY value 'parallel'. Expected 'single' or 'pool'.");
  });
});

describe('resolvePlaywrightTimeouts', () => {
  test('uses the historical local Playwright timeouts by default', () => {
    expect(resolvePlaywrightTimeouts({})).toEqual({
      testTimeoutMs: 15 * 60 * 1000,
      expectTimeoutMs: 60 * 1000
    });
  });

  test('respects configured test and expect timeouts', () => {
    expect(
      resolvePlaywrightTimeouts({
        PLAYWRIGHT_TIMEOUT_MS: '360000',
        PLAYWRIGHT_EXPECT_TIMEOUT_MS: '45000'
      })
    ).toEqual({
      testTimeoutMs: 360000,
      expectTimeoutMs: 45000
    });
  });

  test.each(['', '0', '-1', 'abc', '2.5'])('falls back for invalid timeout value %p', timeout => {
    expect(
      resolvePlaywrightTimeouts({
        PLAYWRIGHT_TIMEOUT_MS: timeout,
        PLAYWRIGHT_EXPECT_TIMEOUT_MS: timeout
      })
    ).toEqual({
      testTimeoutMs: 15 * 60 * 1000,
      expectTimeoutMs: 60 * 1000
    });
  });
});
