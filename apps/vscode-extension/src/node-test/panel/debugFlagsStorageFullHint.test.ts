import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import proxyquire from 'proxyquire';

import { getMessages } from '../../../../../packages/webview/src/i18n';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');
const bundle = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(extensionRoot, 'l10n', file), 'utf8'));

const LOCALES = [
  { locale: 'en', bundle: 'bundle.l10n.json' },
  { locale: 'pt-BR', bundle: 'bundle.l10n.pt-br.json' }
];
const target = { type: 'user', userId: '005000000000001AAA' } as const;
const storageFull = new Error('STORAGE_LIMIT_EXCEEDED: storage limit exceeded');

function panelIn(translations: Record<string, string>) {
  const notifications: string[] = [];
  const posted: Array<{ type: string; message?: string }> = [];
  const { DebugFlagsPanel } = proxyquire.noCallThru().noPreserveCache()('../../panel/DebugFlagsPanel', {
    vscode: {
      window: {
        showErrorMessage: async (message: string) => {
          notifications.push(message);
          return undefined;
        }
      }
    },
    '../host/salesforce/traceflags': {},
    '../host/services/apexLogCleanup': {},
    '../host/utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) =>
        (translations[message] ?? message).replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)]))
    },
    '../host/utils/logsCleanup': {},
    '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '' },
    '../shared/telemetry': { safeSendEvent: () => undefined },
    '../runtime/runtimeClient': {
      runtimeClient: {
        getOrgAuth: async () => ({
          username: 'user@example.com',
          instanceUrl: 'https://example.com',
          accessToken: 'x'
        }),
        traceFlagApply: async () => {
          throw storageFull;
        },
        traceFlagRemove: async () => {
          throw storageFull;
        }
      }
    }
  }) as typeof import('../../panel/DebugFlagsPanel');
  const panel = Object.assign(Object.create(DebugFlagsPanel.prototype), {
    disposed: false,
    selectedOrg: 'user@example.com',
    statusToken: 0,
    lastSourceView: 'logs',
    panel: { webview: { postMessage: async (message: { type: string }) => posted.push(message) } }
  });
  const send = async (message: unknown) => await panel.onMessage(message);
  return { send, posted, notifications };
}

suite('the Debug Flags hint for a full org log storage', () => {
  for (const { locale, bundle: file } of LOCALES) {
    test(`names the Clear logs menu items the ${locale} webview shows`, async () => {
      const { logsCleanup } = getMessages(locale);
      assert.ok(logsCleanup);
      const menuPath = `“${logsCleanup.open}” → “${logsCleanup.deleteAll}”`;
      const { send, posted, notifications } = panelIn(bundle(file));

      await send({
        type: 'debugFlagsApply',
        target,
        logType: 'DEVELOPER_LOG',
        debugLevelName: 'ALV_E2E',
        ttlMinutes: 30
      });
      await send({ type: 'debugFlagsRemove', target, logType: 'DEVELOPER_LOG' });

      const errors = posted.filter(message => message.type === 'debugFlagsError').map(message => message.message);
      assert.equal(errors.length, 2);
      assert.equal(notifications.length, 2);
      for (const shown of [...errors, ...notifications]) {
        assert.ok(shown?.includes(menuPath), `${JSON.stringify(shown)} names ${menuPath}`);
      }
    });
  }
});
