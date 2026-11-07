import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

const { presentLogsStatus } = proxyquire.noCallThru().noPreserveCache()(
  '../../host/logsStatusPresentation',
  {
    './utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) =>
        message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  }
) as typeof import('../../host/logsStatusPresentation');

suite('logs status bar presentation', () => {
  test('shows the product name alone until an org is known', () => {
    const view = presentLogsStatus(undefined);
    assert.equal(view.text, '$(output) Apex Logs');
    assert.match(view.tooltip, /Open the Apex Logs panel/);
  });

  test('shows the org and says whose logs the click opens', () => {
    const view = presentLogsStatus('my-sandbox');
    assert.equal(view.text, '$(output) Apex Logs: my-sandbox');
    assert.match(view.tooltip, /logs of my-sandbox/);
  });
});
