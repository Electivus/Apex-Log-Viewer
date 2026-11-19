import assert from 'assert/strict';
import { TestClock } from './testClock';

suite('TestClock', () => {
  test('hands back timer handles that host code can unref, refresh and clear', async () => {
    const clock = new TestClock();
    try {
      let calls = 0;
      const timer = setTimeout(() => {
        calls++;
      }, 10);

      assert.equal(timer.unref().ref().hasRef(), true);

      await clock.advanceBy(10);
      assert.equal(calls, 1, 'the timer fires once its delay elapses');

      timer.refresh();
      await clock.advanceBy(10);
      assert.equal(calls, 2, 'refresh re-arms the timer for its delay');

      timer.refresh();
      clearTimeout(timer);
      await clock.advanceBy(10);
      assert.equal(calls, 2, 'clearTimeout with the handle cancels the timer');
    } finally {
      clock.dispose();
    }
  });
});
