import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import {
  APP_LOG,
  FakeHost,
  LINKED,
  NEBULA,
  createFakeRuntimeClient,
  createMemento,
  entry,
  formatLocalized,
  row,
  settle,
  type RecordedEvent
} from '../customLogsTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const LOG_ID = 'a02000000000001AAA';
const ENTRY_A = 'a01000000000001AAA';
const ENTRY_B = 'a01000000000002AAA';
const STATE_KEY = 'electivus.apexLogViewer.customLogs.payloadColumns';

type EntryResult = {
  entry: { sequence: number; message: string; messageTruncated?: boolean };
  details: Array<Record<string, unknown>>;
  rawPayload: Record<string, unknown>;
};

function entryResult(overrides: Partial<EntryResult> = {}): EntryResult {
  return {
    entry: { sequence: 31, message: 'Divide by 0' },
    details: [
      {
        key: 'ExceptionStackTrace__c',
        label: 'Exception Stack Trace',
        state: 'value',
        value: 'AnonymousBlock: line 7',
        format: 'text'
      },
      {
        key: 'RecordJson__c',
        label: 'Record JSON',
        state: 'value',
        value: '{"Name":"Probe","Big":12345678901234567890}',
        format: 'json',
        truncated: false
      },
      { key: 'HttpRequestBody__c', label: 'Http Request Body', state: 'hidden' },
      { key: 'Tags__c', label: 'Tags', state: 'empty' },
      { key: 'Unused__c', label: 'Unused', state: 'unmapped' }
    ],
    rawPayload: { state: 'unmapped' },
    ...overrides
  };
}

function load() {
  const fake = createFakeRuntimeClient();
  const memento = createMemento();
  const events: RecordedEvent[] = [];
  const documents: Array<{ name: string; text: string; format: string }> = [];
  const apexLogOpens: Array<[string, string | undefined]> = [];
  const clipboard: string[] = [];
  const panels: Array<{ host: FakeHost & { title: string; revealed: number; viewType: string } }> = [];

  const vscodeStub = {
    env: { language: 'en', clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
    ViewColumn: { Active: -1 },
    Uri: { joinPath: () => ({}) },
    window: {
      activeTextEditor: undefined,
      createWebviewPanel: (viewType: string) => {
        const host = Object.assign(new FakeHost(), { title: '', revealed: 0, viewType });
        const panel = {
          title: '',
          webview: host.webview,
          reveal: () => void (host.revealed += 1),
          onDidDispose: (listener: () => void) => host.onDidDispose(listener)
        };
        Object.defineProperty(panel, 'title', {
          get: () => host.title,
          set: (value: string) => void (host.title = value)
        });
        panels.push({ host });
        return panel;
      }
    }
  };

  const { CustomLogViewerPanel } = proxyquireStrict('../../panel/CustomLogViewerPanel', {
    vscode: vscodeStub,
    '../host/utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) => formatLocalized(message, ...args)
    },
    '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '<html></html>' },
    '../host/utils/workspace': { findCustomLogsProjectDir: async () => '/project' },
    '../host/utils/customLogDocuments': {
      openCustomLogDocument: async (document: { name: string; text: string; format: string }) =>
        void documents.push(document)
    },
    '../host/services/logService': {
      LogService: class {
        async openLog(logId: string, org?: string) {
          apexLogOpens.push([logId, org]);
        }
      }
    },
    '../runtime/runtimeClient': { runtimeClient: fake.client },
    '../shared/telemetry': {
      safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
        events.push({ name, properties, measurements });
      }
    }
  }) as typeof import('../../panel/CustomLogViewerPanel');

  CustomLogViewerPanel.initialize({ extensionUri: {}, subscriptions: [], workspaceState: memento } as never);

  fake.handlers.customLogGet = async params => ({
    source: { id: 'nebula', label: 'Nebula Logger', shape: 'transactions' },
    log: row(LOG_ID, 'Log-000739', { counts: { entries: 2, errors: 1 } }),
    logPayload: { state: 'value', value: '{"header":true}', format: 'json' },
    entryColumns: [{ key: 'OriginType__c', label: 'Origin Type' }],
    entries: params.cursor ? [entry(ENTRY_B, 2)] : [entry(ENTRY_A, 1)],
    payloadFields: [],
    nextCursor: params.cursor ? null : 'cursor-1',
    apexLog: LINKED
  });
  fake.handlers.customLogSources = async () => ({
    sources: [{ ...NEBULA, payload: { entry: { field: 'Payload__c', columns: ['orderId'] } } }, APP_LOG],
    issues: []
  });
  fake.handlers.customLogEntry = async () => entryResult();

  async function open(options: { targetOrg?: string; sourceId?: string; logId?: string } = {}) {
    await CustomLogViewerPanel.show({ targetOrg: 'dev@example.com', sourceId: 'nebula', logId: LOG_ID, ...options });
    const { host } = panels.at(-1)!;
    await host.emit({ type: 'customLogViewerReady' });
    return host;
  }

  return { CustomLogViewerPanel, fake, memento, events, documents, apexLogOpens, clipboard, panels, open };
}

const textOf = (host: FakeHost) => JSON.stringify(host.posted);

suite('Custom Logs viewer panel', () => {
  test('loads the log, its first entries and the source defaults, and never sends long text to the webview', async () => {
    const { fake, open } = load();

    const host = await open();

    assert.deepEqual(fake.calls.customLogGet, [
      { targetOrg: 'dev@example.com', projectDir: '/project', source: 'nebula', logId: LOG_ID, limit: 200 }
    ]);
    assert.deepEqual(fake.calls.customLogSources, [{ targetOrg: 'dev@example.com', projectDir: '/project' }]);
    assert.deepEqual(
      host.posted.map(message => message.type),
      [
        'customLogViewerLoading',
        'customLogViewerLoading',
        'customLogViewerInit',
        'customLogViewerEntries',
        'customLogViewerLoading',
        'customLogViewerLoading'
      ]
    );
    const init = host.last('customLogViewerInit') as never as Record<string, unknown>;
    assert.deepEqual(init.logPayload, { key: 'payload', label: 'Payload', state: 'value', format: 'json' });
    assert.deepEqual(init.payloadColumns, { defaults: ['orderId'], added: [] });
    assert.deepEqual(init.apexLog, LINKED);
    assert.equal(textOf(host).includes('"header":true'), false, 'the header payload text stays in the host');
    const entries = host.last('customLogViewerEntries') as never as { mode: string; hasMore: boolean };
    assert.equal(entries.mode, 'replace');
    assert.equal(entries.hasMore, true);
    assert.equal(host.title, 'Custom log: Log-000739');
  });

  test('a second request for the same log reveals the open panel', async () => {
    const { panels, open, CustomLogViewerPanel } = load();
    const host = await open();

    await CustomLogViewerPanel.show({ targetOrg: 'dev@example.com', sourceId: 'nebula', logId: LOG_ID });

    assert.equal(panels.length, 1);
    assert.equal(host.revealed, 1);
  });

  test('a failed load says so in the log scope and stops the spinners', async () => {
    const { fake, events, open } = load();
    fake.handlers.customLogGet = async () => {
      throw new Error('Log not found');
    };

    const host = await open();

    assert.deepEqual(host.last('customLogViewerError'), {
      type: 'customLogViewerError',
      scope: 'log',
      message: 'Log not found'
    });
    assert.deepEqual(
      host.posted.slice(-2).map(message => [message.scope, message.value]),
      [
        ['log', false],
        ['entries', false]
      ]
    );
    assert.equal(events.find(event => event.name === 'customLogs.openLog')?.properties?.outcome, 'error');
  });

  suite('entries', () => {
    test('load more continues from the cursor the panel holds and appends', async () => {
      const { fake, open } = load();
      const host = await open();

      await host.emit({ type: 'customLogViewerLoadMoreEntries' });
      await host.emit({ type: 'customLogViewerLoadMoreEntries' });

      assert.equal(fake.calls.customLogGet.length, 2, 'the last page leaves nothing to load');
      assert.equal(fake.calls.customLogGet[1]?.cursor, 'cursor-1');
      const appended = host.last('customLogViewerEntries') as never as { mode: string; hasMore: boolean };
      assert.equal(appended.mode, 'append');
      assert.equal(appended.hasMore, false);
    });

    test('refresh reads the log again from the first page', async () => {
      const { fake, open } = load();
      const host = await open();
      await host.emit({ type: 'customLogViewerLoadMoreEntries' });

      await host.emit({ type: 'customLogViewerRefresh' });

      assert.equal(fake.calls.customLogGet.at(-1)?.cursor, undefined);
      assert.equal((host.last('customLogViewerEntries') as never as { mode: string }).mode, 'replace');
    });
  });

  suite('long fields', () => {
    test("lists an entry's fields by state, message first and payload last, without text and without unmapped ones", async () => {
      const { fake, events, open } = load();
      fake.handlers.customLogEntry = async () =>
        entryResult({
          entry: { sequence: 31, message: 'Divide by 0', messageTruncated: true },
          rawPayload: { state: 'value', value: '{"orderId":1}', format: 'json' }
        });
      const host = await open();
      host.clear();

      await host.emit({ type: 'customLogViewerOpenEntry', entryId: ENTRY_A });

      assert.deepEqual(fake.calls.customLogEntry, [
        { targetOrg: 'dev@example.com', projectDir: '/project', source: 'nebula', entryId: ENTRY_A }
      ]);
      assert.deepEqual(host.last('customLogViewerEntryFields'), {
        type: 'customLogViewerEntryFields',
        entryId: ENTRY_A,
        fields: [
          { key: 'message', label: 'Message', state: 'value', format: 'text', truncated: true },
          { key: 'ExceptionStackTrace__c', label: 'Exception Stack Trace', state: 'value', format: 'text' },
          { key: 'RecordJson__c', label: 'Record JSON', state: 'value', format: 'json', truncated: false },
          { key: 'HttpRequestBody__c', label: 'Http Request Body', state: 'hidden' },
          { key: 'Tags__c', label: 'Tags', state: 'empty' },
          { key: 'payload', label: 'Payload', state: 'value', format: 'json' }
        ]
      });
      const wire = textOf(host);
      for (const secret of ['AnonymousBlock', 'Probe', 'orderId', 'Divide by 0']) {
        assert.equal(wire.includes(secret), false, `${secret} must stay in the host`);
      }
      assert.equal(events.find(event => event.name === 'customLogs.openEntry')?.properties?.outcome, 'ok');
    });

    test('answers only for entries it delivered', async () => {
      const { fake, open } = load();
      const host = await open();
      host.clear();

      await host.emit({ type: 'customLogViewerOpenEntry', entryId: 'a01000000000999AAA' });
      await host.emit({
        type: 'customLogViewerOpenField',
        target: { kind: 'entry', entryId: 'a01000000000999AAA', key: 'message' }
      });

      assert.equal(fake.calls.customLogEntry.length, 0);
      assert.equal(host.posted.length, 0);
    });

    test('opens a held value as a document named after the field, the log and the entry', async () => {
      const { documents, events, open } = load();
      const host = await open();
      await host.emit({ type: 'customLogViewerOpenEntry', entryId: ENTRY_A });

      await host.emit({
        type: 'customLogViewerOpenField',
        target: { kind: 'entry', entryId: ENTRY_A, key: 'RecordJson__c' }
      });
      await host.emit({
        type: 'customLogViewerOpenField',
        target: { kind: 'entry', entryId: ENTRY_A, key: 'message' }
      });

      assert.deepEqual(documents, [
        { name: 'Record JSON - Log-000739 #31', text: '{"Name":"Probe","Big":12345678901234567890}', format: 'json' },
        { name: 'Message - Log-000739 #31', text: 'Divide by 0', format: 'text' }
      ]);
      assert.deepEqual(
        events.filter(event => event.name === 'customLogs.openField').map(event => event.properties),
        [
          { outcome: 'ok', kind: 'detail', format: 'json' },
          { outcome: 'ok', kind: 'message', format: 'text' }
        ]
      );
    });

    test('does not open a field the panel never offered or one that has no text', async () => {
      const { documents, open } = load();
      const host = await open();
      await host.emit({ type: 'customLogViewerOpenEntry', entryId: ENTRY_A });

      for (const key of ['HttpRequestBody__c', 'Tags__c', 'Unused__c', 'Nope__c', 'payload']) {
        await host.emit({ type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: ENTRY_A, key } });
      }

      assert.deepEqual(documents, []);
    });

    test('fetches the entry on demand when a delivered entry was never opened', async () => {
      const { fake, documents, open } = load();
      const host = await open();

      await host.emit({
        type: 'customLogViewerOpenField',
        target: { kind: 'entry', entryId: ENTRY_A, key: 'ExceptionStackTrace__c' }
      });

      assert.equal(fake.calls.customLogEntry.length, 1);
      assert.equal(documents[0]?.text, 'AnonymousBlock: line 7');
    });

    test('a refresh drops the entries it held, so a field opens with the text read after the refresh', async () => {
      const { fake, documents, open } = load();
      const host = await open();
      await host.emit({ type: 'customLogViewerOpenEntry', entryId: ENTRY_A });
      fake.handlers.customLogEntry = async () => entryResult({ entry: { sequence: 31, message: 'Divide by 1' } });

      await host.emit({ type: 'customLogViewerRefresh' });
      await host.emit({
        type: 'customLogViewerOpenField',
        target: { kind: 'entry', entryId: ENTRY_A, key: 'message' }
      });

      assert.equal(fake.calls.customLogEntry.length, 2);
      assert.equal(documents.at(-1)?.text, 'Divide by 1');
    });

    test('opens the header payload the panel holds, and nothing when the source maps none', async () => {
      const { fake, documents, open } = load();
      const host = await open();
      await host.emit({ type: 'customLogViewerOpenField', target: { kind: 'logPayload' } });
      assert.deepEqual(documents, [{ name: 'Payload - Log-000739', text: '{"header":true}', format: 'json' }]);

      const previous = fake.handlers.customLogGet;
      fake.handlers.customLogGet = async params => ({ ...((await previous(params)) as object), logPayload: undefined });
      documents.length = 0;
      await host.emit({ type: 'customLogViewerRefresh' });
      await host.emit({ type: 'customLogViewerOpenField', target: { kind: 'logPayload' } });
      assert.deepEqual(documents, []);
      assert.equal('logPayload' in (host.last('customLogViewerInit') as object), false);
    });
  });

  suite('Apex log link', () => {
    test('opens the linked Apex log with the id the panel holds, never one from the webview', async () => {
      const { apexLogOpens, events, open } = load();
      const host = await open();

      await host.emit({ type: 'customLogViewerOpenApexLog', logId: '07L000000000999AAA' });

      assert.deepEqual(apexLogOpens, [[LINKED.logId, 'dev@example.com']]);
      assert.equal(events.find(event => event.name === 'customLogs.openApexLog')?.properties?.outcome, 'linked');
    });

    test('opens nothing when there is no link, and records why', async () => {
      const { fake, apexLogOpens, events, open } = load();
      const previous = fake.handlers.customLogGet;
      fake.handlers.customLogGet = async params => ({
        ...((await previous(params)) as object),
        apexLog: { state: 'unavailable', reason: 'noAccess' }
      });
      const host = await open();

      await host.emit({ type: 'customLogViewerOpenApexLog' });

      assert.deepEqual(apexLogOpens, []);
      assert.equal(events.find(event => event.name === 'customLogs.openApexLog')?.properties?.outcome, 'unavailable');
    });
  });

  suite('JSON columns and clipboard', () => {
    test("stores the columns the user adds for the source's entries and answers with the effective list", async () => {
      const { memento, open } = load();
      const host = await open();

      await host.emit({ type: 'customLogViewerSetPayloadColumns', added: ['http.status', 'orderId'] });

      assert.deepEqual(memento.values.get(STATE_KEY), { 'entry:nebula': ['http.status', 'orderId'] });
      assert.deepEqual(host.last('customLogViewerPayloadColumns'), {
        type: 'customLogViewerPayloadColumns',
        value: { defaults: ['orderId'], added: ['http.status'] }
      });
    });

    test('copies text through the host clipboard', async () => {
      const { clipboard, open } = load();
      const host = await open();

      await host.emit({ type: 'customLogViewerCopyText', text: 'ae12d024-5b1c-4f0e-9d5e-1b8c0d1f2a77' });
      await host.emit({ type: 'customLogViewerCopyText', text: '' });

      assert.deepEqual(clipboard, ['ae12d024-5b1c-4f0e-9d5e-1b8c0d1f2a77']);
      await settle();
    });
  });
});
