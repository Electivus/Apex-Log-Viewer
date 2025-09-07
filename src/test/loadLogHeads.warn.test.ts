import assert from 'assert/strict';
import * as vscode from 'vscode';
import type { OrgAuth } from '../salesforce/types';
const proxyquire: any = require('proxyquire');

suite('loadLogHeads warning', () => {
  test('posts warning once when head fetch fails', async () => {
    const fetchStub = async () => {
      throw new Error('boom');
    };
    const http = require('../salesforce/http');
    const { SfLogsViewProvider } = proxyquire('../provider/SfLogsViewProvider', {
      '../salesforce/http': { ...http, fetchApexLogHead: fetchStub }
    });
    const provider = new SfLogsViewProvider({
      extensionUri: vscode.Uri.file('.'),
      subscriptions: []
    } as unknown as vscode.ExtensionContext);
    const messages: any[] = [];
    (provider as any).post = (msg: any) => {
      messages.push(msg);
    };
    (provider as any).headLimiter = async (fn: any) => {
      await fn();
    };
    const logs = [{ Id: '1' }, { Id: '2' }] as any;
    const auth: OrgAuth = { accessToken: '', instanceUrl: '', username: '' };
    (provider as any).loadLogHeads(logs, auth, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 1, 'should notify once');
    assert.equal(messages[0].type, 'error');
    assert.ok(messages[0].message.includes('boom'));
  });
});
