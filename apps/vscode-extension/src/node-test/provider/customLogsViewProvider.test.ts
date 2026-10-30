import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';
import {
  APP_LOG,
  FakeHost,
  LOG_IDS,
  NEBULA,
  createFakeRuntimeClient,
  createMemento,
  field,
  formatLocalized,
  resetVscodeStub,
  row,
  vscodeStub,
  type RecordedEvent
} from '../customLogsTestSupport';

const proxyquireStrict = proxyquire.noCallThru().noPreserveCache();

const STATE_KEY = 'electivus.apexLogViewer.customLogs.payloadColumns';

function load(options: { projectDefaultOrg?: string } = {}) {
  const clock = new FakeClock();
  const fake = createFakeRuntimeClient();
  const memento = createMemento();
  const events: RecordedEvent[] = [];
  const documents: Array<{ name: string; text: string; format: string }> = [];
  const viewerOpens: Array<Record<string, unknown>> = [];
  const projectWatchers: Array<() => void> = [];
  resetVscodeStub();

  const { CustomLogsViewProvider } = proxyquireStrict('../../provider/CustomLogsViewProvider', {
    vscode: vscodeStub,
    '../host/utils/localize': {
      localize: (_key: string, message: string, ...args: Array<string | number>) => formatLocalized(message, ...args)
    },
    '../host/utils/logger': { logInfo: () => undefined, logWarn: () => undefined },
    '../host/utils/orgManager': {
      OrgManager: class {
        async ensureProjectDefaultSelected() {}
        getSelectedOrg() {
          return options.projectDefaultOrg;
        }
      }
    },
    '../host/utils/responsiveness': { recordInboundMessage: () => undefined },
    '../host/utils/webviewHtml': { buildWebviewHtml: () => '<html></html>' },
    '../host/utils/workspace': {
      findCustomLogsProjectDir: async () => '/project',
      onSfdxProjectFileChanged: (listener: () => void) => {
        projectWatchers.push(listener);
        return { dispose: () => undefined };
      }
    },
    '../host/utils/customLogDocuments': {
      openCustomLogDocument: async (document: { name: string; text: string; format: string }) => {
        documents.push(document);
      }
    },
    '../panel/CustomLogViewerPanel': {
      CustomLogViewerPanel: {
        show: async (options: Record<string, unknown>) => {
          viewerOpens.push(options);
        }
      }
    },
    '../runtime/runtimeClient': { runtimeClient: fake.client },
    '../shared/telemetry': {
      safeSendEvent: (name: string, properties?: Record<string, string>, measurements?: Record<string, number>) => {
        events.push({ name, properties, measurements });
      }
    },
    './webviewHost': {
      createWebviewViewHost: (view: unknown) => view,
      createWebviewPanelHost: (panel: unknown) => panel
    },
    './webviewSession': {
      createWebviewSession: (options: never) => createWebviewSessionForTest(options, clock)
    }
  }) as typeof import('../../provider/CustomLogsViewProvider');

  const create = () => new CustomLogsViewProvider({ extensionUri: {}, workspaceState: memento } as never);
  const provider = create();

  async function mount(host: FakeHost, mountSequence = 1, target: typeof provider = provider): Promise<void> {
    target.resolveWebviewView(host as never);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await host.emit({ type: 'customLogsReady', mountSequence });
  }

  return { provider, create, clock, fake, memento, events, documents, viewerOpens, projectWatchers, mount };
}

const types = (host: FakeHost): string[] => host.posted.map(message => message.type);

suite('Custom Logs view provider', () => {
  test('lists the orgs, detects the sources and loads the first page of the first ready source', async () => {
    const { fake, mount } = load();
    const host = new FakeHost();

    await mount(host);

    const sources = host.last('customLogsSources') as never as { data: unknown[]; selected?: string };
    assert.equal(sources.selected, 'nebula');
    assert.equal(sources.data.length, 3);
    assert.deepEqual(host.last('customLogsOrgs')?.selected, 'dev@example.com');
    assert.deepEqual(fake.calls.customLogSources, [
      { targetOrg: 'dev@example.com', projectDir: '/project', refresh: false }
    ]);
    assert.deepEqual(fake.calls.customLogList, [
      { targetOrg: 'dev@example.com', projectDir: '/project', source: 'nebula', filter: {}, limit: 50 }
    ]);
    const page = host.last('customLogsPage') as never as {
      mode: string;
      rows: Array<{ id: string }>;
      hasMore: boolean;
    };
    assert.equal(page.mode, 'replace');
    assert.deepEqual(
      page.rows.map(r => r.id),
      [LOG_IDS.first, LOG_IDS.second]
    );
    assert.equal(page.hasMore, false);
    assert.equal(host.last('customLogsLoading')?.value, false);
  });

  test('starts on the workspace target org, not the global default of the CLI', async () => {
    const { fake, mount } = load({ projectDefaultOrg: 'qa@example.com' });
    const host = new FakeHost();

    await mount(host);

    assert.equal(host.last('customLogsOrgs')?.selected, 'qa@example.com');
    assert.equal(fake.calls.customLogSources[0]?.targetOrg, 'qa@example.com');
  });

  test('prefers the only ready source core names as the default over the first ready one', async () => {
    const { fake, mount } = load();
    fake.handlers.customLogSources = async () => ({
      defaultSourceId: 'app-log',
      sources: [NEBULA, APP_LOG],
      issues: []
    });
    const host = new FakeHost();

    await mount(host);

    assert.equal(host.last('customLogsSources')?.selected, 'app-log');
    assert.equal(fake.calls.customLogList[0]?.source, 'app-log');
  });

  test('a remount replays the latest screen without asking Salesforce again', async () => {
    const { provider, fake, mount } = load();
    fake.handlers.customLogList = async params =>
      params.cursor
        ? {
            columns: [{ key: 'Status__c', label: 'Status' }],
            rows: [row(LOG_IDS.third)],
            payloadFields: [field('orderId', 1, ['number']), field('http.status')],
            nextCursor: null
          }
        : {
            columns: [{ key: 'Status__c', label: 'Status' }],
            rows: [row(LOG_IDS.first), row(LOG_IDS.second)],
            payloadFields: [field('orderId', 2)],
            nextCursor: 'cursor-1'
          };
    const first = new FakeHost();
    await mount(first);
    await first.emit({ type: 'customLogsLoadMore' });
    assert.equal(first.last('customLogsPage')?.mode, 'append');
    const callsBefore = [fake.calls.customLogSources.length, fake.calls.customLogList.length];

    const second = new FakeHost();
    await mount(second, 2);

    assert.deepEqual(types(second), [
      'customLogsInit',
      'customLogsOrgs',
      'customLogsSources',
      'customLogsFilter',
      'customLogsPayloadColumns',
      'customLogsPage',
      'customLogsLoading',
      'customLogsError'
    ]);
    const page = second.last('customLogsPage') as never as {
      mode: string;
      columns: unknown[];
      rows: Array<{ id: string }>;
      payloadFields: unknown[];
      hasMore: boolean;
    };
    assert.equal(page.mode, 'replace');
    assert.deepEqual(
      page.rows.map(r => r.id),
      [LOG_IDS.first, LOG_IDS.second, LOG_IDS.third]
    );
    assert.deepEqual(page.columns, [{ key: 'Status__c', label: 'Status' }]);
    assert.deepEqual(page.payloadFields, [
      { path: 'orderId', types: ['string', 'number'], rows: 3 },
      { path: 'http.status', types: ['string'], rows: 1 }
    ]);
    assert.equal(page.hasMore, false);
    assert.deepEqual(second.last('customLogsInit'), { type: 'customLogsInit', locale: 'en', surface: 'view' });
    assert.equal(second.last('customLogsLoading')?.value, false);
    assert.equal(second.last('customLogsError')?.message, undefined);
    assert.deepEqual([fake.calls.customLogSources.length, fake.calls.customLogList.length], callsBefore);
    provider.dispose();
  });

  test('the editor tab announces itself so the webview hides "open in editor"', async () => {
    const { provider, clock } = load();
    const host = new FakeHost();

    provider.resolveWebviewPanel(host as never);
    await clock.advanceBy(WEBVIEW_SESSION_MOUNT_DELAY_MS);
    await host.emit({ type: 'customLogsReady', mountSequence: 1 });

    assert.equal(host.last('customLogsInit')?.surface, 'editor');
  });

  suite('paging and filters', () => {
    function pagedList(fake: ReturnType<typeof createFakeRuntimeClient>) {
      fake.handlers.customLogList = async params => {
        const filter = (params.filter ?? {}) as Record<string, unknown>;
        const filtered = Object.keys(filter).length > 0;
        return {
          columns: [],
          rows: [row(filtered ? LOG_IDS.third : LOG_IDS.first)],
          payloadFields: [field(filtered ? 'http.status' : 'orderId')],
          nextCursor: params.cursor ? null : filtered ? 'cursor-filtered' : 'cursor-unfiltered'
        };
      };
    }

    test('load more sends the cursor the provider holds and appends', async () => {
      const { fake, mount } = load();
      pagedList(fake);
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsLoadMore' });
      await host.emit({ type: 'customLogsLoadMore' });

      assert.equal(fake.calls.customLogList.length, 2, 'the last page has no cursor, so there is nothing more to load');
      assert.equal(fake.calls.customLogList[1]?.cursor, 'cursor-unfiltered');
      assert.equal(host.last('customLogsPage')?.mode, 'append');
    });

    test('a new filter restarts paging: no cursor, a replace page and fresh payload fields', async () => {
      const { fake, mount } = load();
      pagedList(fake);
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'ERROR', since: '24h' } });

      assert.deepEqual(host.last('customLogsFilter')?.value, { minLevel: 'ERROR', since: '24h' });
      const request = fake.calls.customLogList.at(-1)!;
      assert.deepEqual(request.filter, { minLevel: 'ERROR', since: '24h' });
      assert.equal('cursor' in request, false);
      const page = host.last('customLogsPage') as never as { mode: string; payloadFields: unknown[] };
      assert.equal(page.mode, 'replace');
      assert.deepEqual(page.payloadFields, [field('http.status')]);

      await host.emit({ type: 'customLogsLoadMore' });
      assert.equal(fake.calls.customLogList.at(-1)?.cursor, 'cursor-filtered');
    });

    test('a filter that fails to load leaves no cursor to load more from', async () => {
      const { fake, mount } = load();
      pagedList(fake);
      const host = new FakeHost();
      await mount(host);
      const list = fake.handlers.customLogList!;
      fake.handlers.customLogList = async params => {
        if (Object.keys((params.filter ?? {}) as object).length > 0) {
          throw new Error('INVALID_FILTER');
        }
        return list(params);
      };

      await host.emit({ type: 'customLogsSetFilter', filter: { since: '24h' } });

      assert.equal(host.last('customLogsError')?.message, 'INVALID_FILTER');
      assert.equal((host.last('customLogsPage') as never as { hasMore: boolean }).hasMore, false);
      const callsBefore = fake.calls.customLogList.length;
      await host.emit({ type: 'customLogsLoadMore' });
      assert.equal(fake.calls.customLogList.length, callsBefore, 'the old cursor does not belong to the new filter');
    });

    test('an empty filter clears every server-side condition', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSetFilter', filter: { user: 'dev@example.com' } });

      await host.emit({ type: 'customLogsSetFilter', filter: {} });

      assert.deepEqual(host.last('customLogsFilter')?.value, {});
      assert.deepEqual(fake.calls.customLogList.at(-1)?.filter, {});
    });

    test('keeps a filter only to the extent the selected source supports it', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      await host.emit({
        type: 'customLogsSetFilter',
        filter: { minLevel: 'WARN', user: 'dev@example.com', since: '7d' }
      });

      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });

      assert.deepEqual(host.last('customLogsFilter')?.value, { since: '7d' });
      assert.deepEqual(fake.calls.customLogList.at(-1)?.filter, { since: '7d' });

      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'ERROR' } });
      assert.deepEqual(host.last('customLogsFilter')?.value, {});
      assert.deepEqual(fake.calls.customLogList.at(-1)?.filter, {});
    });

    test('a filter typed with a source switch reaches the new source in one query, from a fresh cursor', async () => {
      const { fake, mount } = load();
      pagedList(fake);
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });
      assert.equal(host.last('customLogsPage')?.hasMore, true);
      host.clear();
      const before = fake.calls.customLogList.length;

      await host.emit({
        type: 'customLogsSelectSource',
        sourceId: 'nebula',
        filter: { minLevel: 'ERROR', since: '24h' }
      });

      const requests = fake.calls.customLogList.slice(before);
      assert.deepEqual(
        requests.map(request => [request.source, request.filter]),
        [['nebula', { minLevel: 'ERROR', since: '24h' }]],
        'app-log cannot filter by level, so the level must not pass through it'
      );
      assert.equal('cursor' in requests[0]!, false);
      assert.deepEqual(types(host), [
        'customLogsLoading',
        'customLogsPage',
        'customLogsSources',
        'customLogsFilter',
        'customLogsPayloadColumns',
        'customLogsPage',
        'customLogsLoading'
      ]);
      assert.deepEqual(host.last('customLogsFilter')?.value, { minLevel: 'ERROR', since: '24h' });

      await host.emit({ type: 'customLogsLoadMore' });
      assert.equal(fake.calls.customLogList.at(-1)?.cursor, 'cursor-filtered');
    });

    test('a filter typed with the source already on screen applies as a filter change', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      const before = fake.calls.customLogList.length;

      await host.emit({ type: 'customLogsSelectSource', sourceId: 'nebula', filter: { minLevel: 'ERROR' } });

      assert.deepEqual(
        fake.calls.customLogList.slice(before).map(request => [request.source, request.filter]),
        [['nebula', { minLevel: 'ERROR' }]]
      );
      assert.deepEqual(host.last('customLogsFilter')?.value, { minLevel: 'ERROR' });
    });

    test('a superseded request never overwrites the newer page or flashes an error', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      let releaseStale!: () => void;
      const stale = new Promise<void>(resolve => {
        releaseStale = resolve;
      });
      fake.handlers.customLogList = async params => {
        const filtered = Object.keys((params.filter ?? {}) as object).length > 0;
        if (!filtered) {
          await stale;
        }
        return {
          columns: [],
          rows: [row(filtered ? LOG_IDS.second : LOG_IDS.first)],
          payloadFields: [],
          nextCursor: null
        };
      };

      void host.emit({ type: 'customLogsRefresh' });
      await settle();
      await host.emit({ type: 'customLogsSetFilter', filter: { since: '1h' } });
      releaseStale();
      await settle();

      const pages = host.ofType('customLogsPage') as never as Array<{ rows: Array<{ id: string }> }>;
      assert.deepEqual(
        pages.at(-1)?.rows.map(r => r.id),
        [LOG_IDS.second]
      );
      assert.equal(host.last('customLogsError')?.message, undefined);
      assert.equal(host.last('customLogsLoading')?.value, false);
    });
  });

  suite('org and source selection', () => {
    test('ignores an org the host never listed, resolves an alias, and reloads for the new org from an empty page', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      host.clear();

      await host.emit({ type: 'customLogsSelectOrg', target: 'someone-else@example.com' });
      assert.equal(host.posted.length, 0);
      assert.equal(fake.calls.customLogSources.length, 1);

      await host.emit({ type: 'customLogsSelectOrg', target: 'qa' });

      assert.equal(host.last('customLogsOrgs')?.selected, 'qa@example.com');
      assert.equal(fake.calls.customLogSources.at(-1)?.targetOrg, 'qa@example.com');
      assert.equal(fake.calls.customLogList.at(-1)?.targetOrg, 'qa@example.com');
      const pages = host.ofType('customLogsPage') as never as Array<{ rows: unknown[] }>;
      assert.deepEqual(pages[0]?.rows, [], 'the previous org rows are cleared before the new ones arrive');
      assert.equal(pages.at(-1)?.rows.length, 2);
    });

    test('keeps the source the user chose across orgs and config reloads while it is ready', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });
      assert.equal(host.last('customLogsSources')?.selected, 'app-log');

      fake.handlers.customLogSources = async () => ({ sources: [NEBULA], issues: [] });
      await host.emit({ type: 'customLogsSelectOrg', target: 'qa' });
      assert.equal(host.last('customLogsSources')?.selected, 'nebula', 'app-log is not in that org');

      fake.handlers.customLogSources = async () => ({ sources: [NEBULA, APP_LOG], issues: [] });
      await host.emit({ type: 'customLogsSelectOrg', target: 'dev' });
      assert.equal(host.last('customLogsSources')?.selected, 'app-log', 'the choice comes back with the source');
    });

    test('a mapping edit that adds a source does not move the list off the one on screen', async () => {
      const { fake, projectWatchers, mount } = load();
      fake.handlers.customLogSources = async () => ({ sources: [NEBULA], issues: [] });
      const host = new FakeHost();
      await mount(host);
      assert.equal(host.last('customLogsSources')?.selected, 'nebula');
      host.clear();

      fake.handlers.customLogSources = async () => ({ sources: [APP_LOG, NEBULA], issues: [] });
      projectWatchers[0]!();
      await settle();

      assert.equal(
        host.last('customLogsSources')?.selected,
        'nebula',
        'the config source sorts first, but the user did not ask for it'
      );
      assert.equal(fake.calls.customLogList.at(-1)?.source, 'nebula');
      const pages = host.ofType('customLogsPage') as never as Array<{ rows: unknown[] }>;
      assert.equal(pages.length, 1, 'the rows stay until the new page arrives');
      assert.equal(pages[0]?.rows.length, 2);
    });

    test('refuses a source that is missing or not ready, and clears the old rows when a switch is accepted', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);
      const listCalls = fake.calls.customLogList.length;

      await host.emit({ type: 'customLogsSelectSource', sourceId: 'nebula-managed' });
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'unknown-source' });
      assert.equal(fake.calls.customLogList.length, listCalls);

      host.clear();
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });
      const pages = host.ofType('customLogsPage') as never as Array<{ rows: unknown[] }>;
      assert.deepEqual(pages[0]?.rows, []);
      assert.equal(fake.calls.customLogList.at(-1)?.source, 'app-log');
    });

    test('no orgs means no source detection and no query', async () => {
      const { fake, mount } = load();
      fake.handlers.orgList = async () => [];
      const host = new FakeHost();

      await mount(host);

      assert.deepEqual(host.last('customLogsOrgs')?.data, []);
      assert.equal(fake.calls.customLogSources.length, 0);
      assert.equal(host.ofType('customLogsSources').length, 0);
    });
  });

  suite('opening records', () => {
    test('opens the viewer only for a record the host listed', async () => {
      const { viewerOpens, mount } = load();
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsOpenLog', logId: 'a02000000000999AAA' });
      assert.deepEqual(viewerOpens, []);

      await host.emit({ type: 'customLogsOpenLog', logId: LOG_IDS.second });
      assert.deepEqual(viewerOpens, [
        { targetOrg: 'dev@example.com', sourceId: 'nebula', logId: LOG_IDS.second, payloadDefaults: [] }
      ]);
    });

    test("hands the viewer the entry JSON columns the source's mapping defaults", async () => {
      const { viewerOpens, mount } = load();
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });

      await host.emit({ type: 'customLogsOpenLog', logId: LOG_IDS.first });

      assert.deepEqual(viewerOpens.at(-1)?.payloadDefaults, ['orderId']);
    });

    test('opens the header payload of a listed transaction as a document, through get', async () => {
      const { fake, documents, mount } = load();
      fake.handlers.customLogGet = async () => ({
        logPayload: { state: 'value', value: '{"a":1}', format: 'json' }
      });
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsOpenPayload', logId: 'a02000000000999AAA' });
      assert.equal(fake.calls.customLogGet.length, 0, 'an unlisted id never reaches Salesforce');

      await host.emit({ type: 'customLogsOpenPayload', logId: LOG_IDS.first });

      assert.equal(fake.calls.customLogGet.length, 1);
      assert.equal(fake.calls.customLogGet[0]?.logId, LOG_IDS.first);
      assert.equal(fake.calls.customLogGet[0]?.limit, 1);
      assert.deepEqual(documents, [{ name: `Payload - ${LOG_IDS.first}`, text: '{"a":1}', format: 'json' }]);
    });

    test('opens the raw payload of a listed entry through entry', async () => {
      const { fake, documents, events, mount } = load();
      fake.handlers.customLogList = async () => ({
        columns: [],
        rows: [row('a0B000000000001AAA', 'Order sync failed')],
        payloadFields: [],
        nextCursor: null
      });
      fake.handlers.customLogEntry = async () => ({ rawPayload: { state: 'value', value: 'order=1', format: 'text' } });
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });

      await host.emit({ type: 'customLogsOpenPayload', logId: 'a0B000000000001AAA' });

      assert.equal(fake.calls.customLogEntry[0]?.entryId, 'a0B000000000001AAA');
      assert.equal(fake.calls.customLogEntry[0]?.source, 'app-log');
      assert.deepEqual(documents, [{ name: 'Payload - Order sync failed', text: 'order=1', format: 'text' }]);
      assert.deepEqual(events.find(event => event.name === 'customLogs.openField')?.properties, {
        outcome: 'ok',
        kind: 'payload',
        format: 'text'
      });
    });

    test('says why a payload cannot be opened instead of opening an empty document', async () => {
      const { fake, documents, mount } = load();
      const host = new FakeHost();
      await mount(host);

      for (const [state, text] of [
        ['empty', 'This record has no payload.'],
        ['hidden', 'You do not have permission to read this payload.'],
        ['unmapped', 'This source does not map a payload.']
      ] as const) {
        fake.handlers.customLogGet = async () => (state === 'unmapped' ? {} : { logPayload: { state } });
        await host.emit({ type: 'customLogsOpenPayload', logId: LOG_IDS.first });
        assert.equal(vscodeStub.window.infoMessages.at(-1), text);
      }
      assert.deepEqual(documents, []);
    });

    test('a failed payload read shows in the banner', async () => {
      const { fake, mount } = load();
      fake.handlers.customLogGet = async () => {
        throw new Error('Request timed out');
      };
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsOpenPayload', logId: LOG_IDS.first });

      assert.equal(host.last('customLogsError')?.message, 'Request timed out');
    });
  });

  suite('JSON columns', () => {
    test('stores what the user adds per source and level, never in the project, and sends the effective columns back', async () => {
      const { memento, mount } = load();
      const host = new FakeHost();
      await mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });
      assert.deepEqual(host.last('customLogsPayloadColumns')?.value, { defaults: ['orderId'], added: [] });

      await host.emit({ type: 'customLogsSetPayloadColumns', added: ['http.status', 'orderId'] });

      assert.deepEqual(memento.values.get(STATE_KEY), { 'entry:app-log': ['http.status', 'orderId'] });
      assert.deepEqual(host.last('customLogsPayloadColumns')?.value, { defaults: ['orderId'], added: ['http.status'] });
    });

    test('a source that maps no payload at its level keeps nothing', async () => {
      const { memento, mount } = load();
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsSetPayloadColumns', added: ['http.status'] });

      assert.equal(memento.values.has(STATE_KEY), false);
    });

    test('a new session over the same workspace starts with the stored columns', async () => {
      const { create, memento, mount } = load();
      memento.values.set(STATE_KEY, { 'entry:app-log': ['http.status'] });
      const provider = create();
      const host = new FakeHost();
      provider.setSelectedOrg('dev@example.com');

      await mount(host, 1, provider);
      await host.emit({ type: 'customLogsSelectSource', sourceId: 'app-log' });

      assert.deepEqual(host.last('customLogsPayloadColumns')?.value, { defaults: ['orderId'], added: ['http.status'] });
    });
  });

  suite('project mapping changes', () => {
    test('re-resolves the sources and reloads the page when sfdx-project.json changes', async () => {
      const { fake, projectWatchers, mount } = load();
      const host = new FakeHost();
      await mount(host);
      fake.handlers.customLogSources = async () => ({
        sources: [NEBULA, { ...APP_LOG, label: 'App Log v2' }],
        issues: [
          { severity: 'warning', pointer: '/plugins/electivus/customLogs/sources/0/typo', message: 'Unknown key' }
        ]
      });

      projectWatchers[0]!();
      await settle();

      assert.equal(fake.calls.customLogSources.length, 2);
      assert.equal(
        fake.calls.customLogSources[1]?.refresh,
        false,
        'core keys its detection memo by the mapping, so a save must not drop what it already learned'
      );
      assert.equal(fake.calls.customLogList.length, 2);
      const sources = host.last('customLogsSources') as never as { issues: unknown[]; data: Array<{ label: string }> };
      assert.equal(sources.issues.length, 1);
      assert.equal(sources.data[1]?.label, 'App Log v2');
    });

    test('a change while no webview is bound is applied when the next one is ready', async () => {
      const { fake, projectWatchers, mount } = load();
      const first = new FakeHost();
      await mount(first);
      first.dispose();
      await settle();

      projectWatchers[0]!();
      await settle();
      assert.equal(fake.calls.customLogSources.length, 1);

      await mount(new FakeHost(), 2);
      assert.equal(fake.calls.customLogSources.length, 2);
      assert.equal(fake.calls.customLogSources[1]?.refresh, false);
    });

    test('the refresh button drops the cached detection', async () => {
      const { fake, mount } = load();
      const host = new FakeHost();
      await mount(host);

      await host.emit({ type: 'customLogsRefresh' });

      assert.equal(fake.calls.customLogSources.at(-1)?.refresh, true);
      assert.equal(fake.calls.customLogList.length, 2);
    });
  });

  suite('failures', () => {
    test('shows the failure in the banner, clears it on the next attempt and retries on the next ready', async () => {
      const { fake, mount } = load();
      let failing = true;
      fake.handlers.customLogSources = async () => {
        if (failing) {
          throw new Error('INVALID_SESSION_ID');
        }
        return { sources: [NEBULA], issues: [] };
      };
      const first = new FakeHost();
      await mount(first);
      assert.equal(first.last('customLogsError')?.message, 'INVALID_SESSION_ID');
      assert.equal(first.last('customLogsLoading')?.value, false);

      failing = false;
      const second = new FakeHost();
      await mount(second, 2);

      assert.equal(second.last('customLogsSources')?.selected, 'nebula');
      assert.equal(second.last('customLogsError')?.message, undefined);
    });

    test('an aborted request is not a failure', async () => {
      const { fake, mount } = load();
      fake.handlers.customLogList = async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      };
      const host = new FakeHost();

      await mount(host);

      assert.equal(host.last('customLogsError')?.message, undefined);
    });

    test('reports no object, field or source names in telemetry', async () => {
      const { events, mount } = load();
      const host = new FakeHost();
      await mount(host);

      const sources = events.find(event => event.name === 'customLogs.sources');
      assert.deepEqual(sources?.properties, { outcome: 'ok', hasConfig: 'true', ready: 'true' });
      assert.equal(sources?.measurements?.count, 3);
      assert.equal(events.find(event => event.name === 'customLogs.refresh')?.measurements?.count, 2);
      assert.deepEqual(events.find(event => event.name === 'orgs.list')?.properties, {
        outcome: 'ok',
        view: 'customLogs'
      });
    });
  });

  test('the configure and editor actions go through the extension commands', async () => {
    const { mount } = load();
    const host = new FakeHost();
    await mount(host);

    await host.emit({ type: 'customLogsOpenConfig' });
    await host.emit({ type: 'customLogsOpenEditor' });

    assert.deepEqual(vscodeStub.commands.executed, [
      'electivus.apexLogViewer.customLogs.configure',
      'electivus.apexLogViewer.customLogs.openEditor'
    ]);
  });

  test('ignores messages that do not parse', async () => {
    const { fake, mount } = load();
    const host = new FakeHost();
    await mount(host);
    const calls = fake.calls.customLogList.length;

    await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'LOUD' } });
    await host.emit({ type: 'customLogsOpenLog', logId: '../../etc/passwd' });
    await host.emit({ type: 'customLogsSelectSource', sourceId: 'Not A Source' });

    assert.equal(fake.calls.customLogList.length, calls);
  });
});
