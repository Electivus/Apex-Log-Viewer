#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import runStep from '../steps/debug-flags-apply-remove.mjs';

for (const target of ['dedicated', 'current', 'fallback']) {
  test(`refuses a ${target} user with an existing DEVELOPER_LOG flag before writes`, async () => {
    let removals = 0;
    let opened = false;
    const h = {
      orgAuth: async () => ({ username: 'current@example.test' }),
      tooling: {
        getCurrentUserId: async () => 'current-user',
        ensureDebugFlagsTestUser: async () => ({ id: target === 'fallback' ? 'current-user' : 'test-user' }),
        getUserDebugTraceFlag: async () => ({ id: 'pre-existing-flag', expirationDate: '2000-01-01T00:00:00Z' }),
        removeUserDebugTraceFlags: async () => {
          removals++;
        }
      },
      openDebugFlagsFromLogs: async () => {
        opened = true;
        throw new Error('UI reached');
      }
    };
    await assert.rejects(
      runStep({ h, args: { currentUser: target === 'current' } }),
      /Refusing.*existing DEVELOPER_LOG/
    );
    assert.equal(removals, 0);
    assert.equal(opened, false);
  });
}

test('removes its new flag when the Apply action fails after the org write', async () => {
  let flag;
  const controls = {
    fill: async () => {},
    waitFor: async () => {},
    click: async () => {}
  };
  const h = {
    orgAuth: async () => ({ username: 'current@example.test' }),
    tooling: {
      getCurrentUserId: async () => 'current-user',
      ensureDebugFlagsTestUser: async () => ({ id: 'test-user' }),
      getUserDebugTraceFlag: async () => flag,
      removeUserDebugTraceFlags: async () => {
        flag = undefined;
      }
    },
    openDebugFlagsFromLogs: async () => ({
      locator: selector =>
        selector.includes('debug-flags-apply')
          ? {
              click: async () => {
                flag = { id: 'owned-flag' };
                throw new Error('Apply response lost');
              }
            }
          : controls
    })
  };
  const expect = () => ({ toBeEnabled: async () => {} });
  await assert.rejects(runStep({ h, expect, args: {} }), /Apply response lost/);
  assert.equal(flag, undefined);
});
