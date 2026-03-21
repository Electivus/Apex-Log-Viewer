import assert from 'assert/strict';
import {
  __resetApiVersionFallbackStateForTests,
  getApiVersion,
  getApiVersionFallbackWarning,
  recordApiVersionFallback,
  resetApiVersion,
  setApiVersion
} from '../salesforce/apiVersion';

suite('apiVersion', () => {
  setup(() => {
    resetApiVersion();
    __resetApiVersionFallbackStateForTests();
  });

  test('resetApiVersion restores the default API version and clears fallback warnings', () => {
    setApiVersion('66.0');
    const auth = {
      accessToken: 'token',
      username: 'demo@example.com',
      instanceUrl: 'https://example.my.salesforce.com'
    };
    recordApiVersionFallback(auth, '66.0', '64.0');

    assert.equal(getApiVersion(), '66.0');
    assert.ok(getApiVersionFallbackWarning(auth));

    resetApiVersion();

    assert.equal(getApiVersion(), '64.0');
    assert.equal(getApiVersionFallbackWarning(auth), undefined);
  });
});
