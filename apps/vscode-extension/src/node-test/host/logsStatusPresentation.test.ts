import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import type { OrgItem } from '../../shared/types';

const { presentLogsStatus, selectedOrgLabel } = proxyquire.noCallThru().noPreserveCache()(
  '../../host/logsStatusPresentation',
  {
    './utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) =>
        message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    }
  }
) as typeof import('../../host/logsStatusPresentation');

const org = (username: string, alias?: string): OrgItem => ({ username, alias }) as OrgItem;

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

  test('labels the selected org by alias, else by username', () => {
    const orgs = [org('a@x.com', 'prod'), org('b@x.com')];
    assert.equal(selectedOrgLabel(orgs, 'a@x.com'), 'prod');
    assert.equal(selectedOrgLabel(orgs, 'b@x.com'), 'b@x.com');
  });

  test('falls back to the username before the org list loads, and to nothing without a selection', () => {
    assert.equal(selectedOrgLabel([], 'a@x.com'), 'a@x.com');
    assert.equal(selectedOrgLabel([org('a@x.com', 'prod')], undefined), undefined);
  });
});
