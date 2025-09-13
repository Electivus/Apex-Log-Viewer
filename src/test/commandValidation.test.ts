import assert from 'assert/strict';
import * as vscode from 'vscode';
import { requireOrgSelected, handleCommandError } from '../utils/commandValidation';
import { logWarn } from '../utils/logger';
import { localize } from '../utils/localize';

suite('commandValidation helpers', () => {
  test('requireOrgSelected shows error when missing org', () => {
    const messages: string[] = [];
    const orig = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = (m: string) => {
      messages.push(m);
      return Promise.resolve(undefined as any);
    };
    try {
      const ok = requireOrgSelected(() => undefined);
      assert.equal(ok, false);
      assert.equal(
        messages[0],
        localize('noOrgSelected', 'Electivus Apex Logs: No Salesforce org selected')
      );
    } finally {
      (vscode.window as any).showErrorMessage = orig;
    }
  });

  test('handleCommandError shows provided message', async () => {
    const messages: string[] = [];
    const orig = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = (m: string) => {
      messages.push(m);
      return Promise.resolve(undefined as any);
    };
    try {
      await handleCommandError(
        async () => {
          throw new Error('boom');
        },
        {
          logMessage: 'boom',
          userMessage: localize('resetCliCacheError', 'Electivus Apex Logs: Failed to clear CLI cache'),
          log: logWarn
        }
      );
      assert.equal(
        messages[0],
        localize('resetCliCacheError', 'Electivus Apex Logs: Failed to clear CLI cache')
      );
    } finally {
      (vscode.window as any).showErrorMessage = orig;
    }
  });
});
