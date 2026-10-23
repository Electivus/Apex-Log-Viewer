import assert from 'assert/strict';
import { LogCachePurgeThrottle } from '../provider/logCachePurgeThrottle';

const scope = { workspaceRoot: '/workspace', username: 'user@example.com' };

suite('LogCachePurgeThrottle', () => {
  test('a purge that throws synchronously does not block the next purge', async () => {
    const throttle = new LogCachePurgeThrottle(() => 0);
    let attempts = 0;
    const purge = () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('purge failed');
      }
      return Promise.resolve();
    };

    await assert.rejects(throttle.run(scope, purge), /purge failed/);
    await throttle.run(scope, purge);

    assert.equal(attempts, 2);
  });

  test('a purge that never settles blocks its key for one hour', async () => {
    let now = 0;
    const throttle = new LogCachePurgeThrottle(() => now);
    let attempts = 0;
    const purge = () => {
      attempts += 1;
      return attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    };

    void throttle.run(scope, purge);
    await Promise.resolve();
    now = 60 * 60 * 1000 - 1;
    await throttle.run(scope, purge);
    assert.equal(attempts, 1);

    now = 60 * 60 * 1000;
    await throttle.run(scope, purge);
    assert.equal(attempts, 2);
  });
});
