import assert from 'node:assert/strict';
import proxyquire from 'proxyquire';

import { WEBVIEW_SESSION_MOUNT_DELAY_MS } from '../../provider/webviewSession';
import { CUSTOM_LOGS_LIVE_ROW_CAP, type CustomLogColumn, type CustomLogRow } from '../../shared/customLogsTypes';
import { FakeClock, createWebviewSessionForTest, settle } from '../webviewSessionTestSupport';
import {
  APP_LOG,
  CAPTURED,
  EVENTS,
  FakeHost,
  LOG_IDS,
  NEBULA,
  NOT_CAPTURED,
  createFakeRuntimeClient,
  createMemento,
  eventId,
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

  suite('event capture', () => {
    const REQUEST_COLUMN: CustomLogColumn = { key: 'Request_Id__c', label: 'Request' };

    /** A project that maps `app-events`; its list answers from `page`, which a test edits as the store fills. */
    function loadEvents() {
      const ctx = load();
      const page = { columns: [] as CustomLogColumn[], rows: [] as CustomLogRow[] };
      ctx.fake.handlers.customLogSources = async () => ({ sources: [NEBULA, EVENTS, APP_LOG], issues: [] });
      ctx.fake.handlers.customLogList = async params =>
        params.source === EVENTS.id
          ? { columns: page.columns, rows: page.rows, payloadFields: [], nextCursor: null, store: NOT_CAPTURED }
          : { columns: [], rows: [row(LOG_IDS.first)], payloadFields: [], nextCursor: null };
      return { ...ctx, page };
    }

    async function openEvents(ctx: ReturnType<typeof loadEvents>) {
      const host = new FakeHost();
      await ctx.mount(host);
      await host.emit({ type: 'customLogsSelectSource', sourceId: EVENTS.id });
      return host;
    }

    const strip = (host: FakeHost) =>
      host.last('customLogsCapture')?.value as never as
        | { capture: { state: string; outcome?: string; code?: string }; wanted: boolean; allowance?: unknown }
        | undefined;

    test('a record source is preferred to an event source, and a project with only event sources opens on the first one', async () => {
      const recordFirst = load();
      const host = new FakeHost();
      await recordFirst.mount(host);
      assert.equal(recordFirst.fake.calls.customLogCapture.length, 0);

      const eventsOnly = load();
      eventsOnly.fake.handlers.customLogSources = async () => ({ sources: [EVENTS], issues: [] });
      const empty = new FakeHost();
      await eventsOnly.mount(empty);
      await settle();
      assert.equal(
        empty.last('customLogsSources')?.selected,
        EVENTS.id,
        'the Source picker needs two ready sources, so a lone event source must be selected for the user'
      );
      assert.equal(eventsOnly.fake.calls.customLogCapture.length, 1);
      assert.equal(eventsOnly.fake.calls.customLogCapture[0]?.params.initial, 'none', 'selecting it buys no replay');

      const listedFirst = load();
      listedFirst.fake.handlers.customLogSources = async () => ({ sources: [EVENTS, NEBULA], issues: [] });
      const mixed = new FakeHost();
      await listedFirst.mount(mixed);
      assert.equal(mixed.last('customLogsSources')?.selected, 'nebula');
      assert.deepEqual(listedFirst.fake.calls.customLogCapture, []);
    });

    test('starts a follow capture once the first page is shown, for the stored position only', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);

      assert.deepEqual(ctx.fake.calls.order, ['list', 'list', 'capture']);
      assert.deepEqual(ctx.fake.calls.customLogCapture[0]?.params, {
        targetOrg: 'dev@example.com',
        projectDir: '/project',
        source: EVENTS.id,
        follow: true,
        initial: 'none',
        filter: {}
      });

      ctx.fake.calls.customLogCapture[0]!.report({ capture: { state: 'connecting' }, store: NOT_CAPTURED });
      await settle();

      assert.deepEqual(strip(host), { capture: { state: 'connecting' }, store: NOT_CAPTURED, wanted: true });
      assert.equal(ctx.provider.getWebviewDiagnosticState().snapshots.captureState, 'connecting');
    });

    test('first use: the page load never buys the replay, the strip choice does, and only once', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const allowance = { remaining: 8_412, max: 10_000, budget: 4_206 };
      const first = ctx.fake.calls.customLogCapture[0]!;
      first.report({ capture: { state: 'stopped', outcome: 'needsInitial' }, store: NOT_CAPTURED, allowance });
      first.end('needsInitial', NOT_CAPTURED);
      await settle();
      assert.deepEqual(strip(host), {
        capture: { state: 'stopped', outcome: 'needsInitial' },
        store: NOT_CAPTURED,
        wanted: true,
        allowance
      });

      await host.emit({ type: 'customLogsRefresh' });
      assert.equal(
        ctx.fake.calls.customLogCapture.length,
        1,
        'refreshing the page does not ask Salesforce for 72 hours'
      );

      await host.emit({ type: 'customLogsCapture', action: 'start', initial: 'retained' });
      assert.equal(ctx.fake.calls.customLogCapture.length, 2);
      assert.equal(ctx.fake.calls.customLogCapture[1]?.params.initial, 'retained');

      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'ERROR' } });
      assert.equal(
        ctx.fake.calls.customLogCapture[2]?.params.initial,
        'none',
        'the choice was spent by the first start'
      );
    });

    test('stored rows join the list newest first, and a remount replays one page and the strip, never live batches', async () => {
      const ctx = loadEvents();
      ctx.page.columns = [REQUEST_COLUMN];
      ctx.page.rows = [row(eventId(2)), row(eventId(1))];
      const host = await openEvents(ctx);
      const capture = ctx.fake.calls.customLogCapture[0]!;

      capture.report({ rows: [row(eventId(3))], payloadFields: [field('orderId')] });
      capture.report({ rows: [row(eventId(5)), row(eventId(4))] });
      await settle();
      assert.equal(host.ofType('customLogsLiveRows').length, 2);

      const listCalls = ctx.fake.calls.customLogList.length;
      const second = new FakeHost();
      await ctx.mount(second, 2);

      assert.deepEqual(types(second), [
        'customLogsInit',
        'customLogsOrgs',
        'customLogsSources',
        'customLogsFilter',
        'customLogsPayloadColumns',
        'customLogsPage',
        'customLogsCapture',
        'customLogsLoading',
        'customLogsError'
      ]);
      const page = second.last('customLogsPage') as never as {
        rows: Array<{ id: string }>;
        payloadFields: unknown[];
      };
      assert.deepEqual(
        page.rows.map(r => r.id),
        [5, 4, 3, 2, 1].map(eventId)
      );
      assert.deepEqual(page.payloadFields, [field('orderId')]);
      assert.deepEqual(strip(second)?.capture, { state: 'live', basis: 'quiet' });
      assert.equal(ctx.fake.calls.customLogList.length, listCalls, 'the remount does not read the store again');
      assert.equal(capture.aborted, false, 'a rebind keeps the capture');
      assert.equal(ctx.fake.calls.customLogCapture.length, 1);
    });

    test('the first stored batch reloads page 1 once, so the mapped columns appear', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const capture = ctx.fake.calls.customLogCapture[0]!;
      const listCalls = ctx.fake.calls.customLogList.length;
      assert.deepEqual((host.last('customLogsPage') as never as { columns: unknown[] }).columns, []);

      ctx.page.columns = [REQUEST_COLUMN];
      ctx.page.rows = [row(eventId(1))];
      capture.report({ rows: [row(eventId(1))] });
      await settle();

      assert.equal(ctx.fake.calls.customLogList.length, listCalls + 1);
      assert.deepEqual((host.last('customLogsPage') as never as { columns: unknown[] }).columns, [REQUEST_COLUMN]);
      for (let n = 2; n < 12; n += 1) {
        capture.report({ rows: [row(eventId(n))] });
      }
      await settle();
      assert.equal(ctx.fake.calls.customLogList.length, listCalls + 1, 'later batches do not reload');
    });

    test('a source that maps no columns reloads once per selection, not once per batch', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const listCalls = ctx.fake.calls.customLogList.length;

      for (let n = 1; n <= 10; n += 1) {
        ctx.fake.calls.customLogCapture[0]!.report({ rows: [row(eventId(n))] });
        await settle();
      }
      assert.equal(ctx.fake.calls.customLogList.length, listCalls + 1);

      await host.emit({ type: 'customLogsSelectSource', sourceId: NEBULA.id });
      await host.emit({ type: 'customLogsSelectSource', sourceId: EVENTS.id });
      const afterReselect = ctx.fake.calls.customLogList.length;
      ctx.fake.calls.customLogCapture[1]!.report({ rows: [row(eventId(11))] });
      await settle();
      assert.equal(ctx.fake.calls.customLogList.length, afterReselect + 1, 'a new selection reloads once more');
    });

    test('past the row cap the list reads its newest page again', async () => {
      const ctx = loadEvents();
      ctx.page.columns = [REQUEST_COLUMN];
      ctx.page.rows = [row(eventId(1))];
      const host = await openEvents(ctx);
      const listCalls = ctx.fake.calls.customLogList.length;

      ctx.fake.calls.customLogCapture[0]!.report({
        rows: Array.from({ length: CUSTOM_LOGS_LIVE_ROW_CAP + 1 }, (_, n) => row(eventId(n + 10)))
      });
      await settle();

      assert.equal(ctx.fake.calls.customLogList.length, listCalls + 1);
      const page = host.last('customLogsPage') as never as { mode: string; rows: Array<{ id: string }> };
      assert.equal(page.mode, 'replace');
      assert.deepEqual(
        page.rows.map(r => r.id),
        [eventId(1)]
      );
    });

    test('restarts for a level or user filter, and keeps running for Refresh and a date range', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const captures = ctx.fake.calls.customLogCapture;

      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'ERROR', user: 'dev@example.com' } });
      assert.equal(captures[0]?.aborted, true);
      assert.deepEqual(captures[1]?.params.filter, { minLevel: 'ERROR', user: 'dev@example.com' });

      await host.emit({
        type: 'customLogsSetFilter',
        filter: { minLevel: 'ERROR', user: 'dev@example.com', since: '24h' }
      });
      await host.emit({ type: 'customLogsRefresh' });
      assert.equal(captures.length, 2);
      assert.equal(captures[1]?.aborted, false);

      await host.emit({ type: 'customLogsSetFilter', filter: {} });
      assert.equal(captures[1]?.aborted, true);
      assert.deepEqual(captures[2]?.params.filter, {});
    });

    test('hears nothing from a capture that was replaced', async () => {
      const ctx = loadEvents();
      ctx.page.columns = [REQUEST_COLUMN];
      const host = await openEvents(ctx);
      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'WARN' } });
      const liveBatches = host.ofType('customLogsLiveRows').length;
      const strips = host.ofType('customLogsCapture').length;

      ctx.fake.calls.customLogCapture[0]!.report({ rows: [row(eventId(9))] });
      await settle();

      assert.equal(host.ofType('customLogsLiveRows').length, liveBatches);
      assert.equal(host.ofType('customLogsCapture').length, strips);
    });

    test('Stop ends the capture and keeps it off through refreshes until Start', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const captures = ctx.fake.calls.customLogCapture;
      captures[0]!.report();
      await settle();

      await host.emit({ type: 'customLogsCapture', action: 'stop' });

      assert.equal(captures[0]?.aborted, true);
      assert.deepEqual(strip(host), {
        capture: { state: 'stopped', outcome: 'aborted' },
        store: CAPTURED,
        wanted: false
      });
      await host.emit({ type: 'customLogsRefresh' });
      await host.emit({ type: 'customLogsSetFilter', filter: { minLevel: 'ERROR' } });
      assert.equal(captures.length, 1);

      await host.emit({ type: 'customLogsCapture', action: 'start' });
      assert.equal(captures.length, 2);
      assert.equal(captures[1]?.params.initial, 'none');
      captures[1]!.report();
      await settle();
      assert.equal(strip(host)?.wanted, true);
    });

    test('Start while a capture is running does not restart it', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);

      await host.emit({ type: 'customLogsCapture', action: 'start' });

      assert.equal(ctx.fake.calls.customLogCapture.length, 1);
      assert.equal(ctx.fake.calls.customLogCapture[0]?.aborted, false);
    });

    test('a record source takes the strip down, and the next event source starts over', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const captures = ctx.fake.calls.customLogCapture;
      captures[0]!.report();
      await settle();
      await host.emit({ type: 'customLogsCapture', action: 'stop' });

      await host.emit({ type: 'customLogsSelectSource', sourceId: APP_LOG.id });

      assert.equal(host.last('customLogsCapture')?.value, undefined);
      assert.equal(captures.length, 1);
      await host.emit({ type: 'customLogsSelectSource', sourceId: EVENTS.id });
      assert.equal(captures.length, 2, 'Stop applied to the source that was left, not to this selection');
    });

    test('another org restarts the capture for that org from a clean strip', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);
      const captures = ctx.fake.calls.customLogCapture;
      captures[0]!.report();
      await settle();

      await host.emit({ type: 'customLogsSelectOrg', target: 'qa' });

      assert.equal(captures[0]?.aborted, true);
      assert.equal(captures[1]?.params.targetOrg, 'qa@example.com');
      assert.equal(captures[1]?.params.source, EVENTS.id);
      assert.equal(host.ofType('customLogsCapture').at(-1)?.value, undefined, 'the old org strip is gone');
    });

    test('stops when the webview goes away and starts again with the next one, without a stale "Live"', async () => {
      const ctx = loadEvents();
      const first = await openEvents(ctx);
      const captures = ctx.fake.calls.customLogCapture;
      captures[0]!.report();
      await settle();

      first.dispose();
      await settle();
      assert.equal(captures[0]?.aborted, true);

      const second = new FakeHost();
      await ctx.mount(second, 2);

      assert.equal(captures.length, 2);
      assert.equal(captures[1]?.params.initial, 'none');
      assert.equal(second.ofType('customLogsCapture').length, 0);
    });

    test('stops on dispose, which is also how turning the setting off ends it', async () => {
      const ctx = loadEvents();
      await openEvents(ctx);

      ctx.provider.dispose();

      assert.equal(ctx.fake.calls.customLogCapture[0]?.aborted, true);
    });

    test('a capture that fails shows in the strip once it exists, and in the banner before that', async () => {
      const failure = Object.assign(new Error('Another client holds the subscription.'), {
        code: 'CUSTOM_LOG_CLIENT_LIMIT'
      });
      const early = loadEvents();
      const earlyHost = await openEvents(early);
      early.fake.calls.customLogCapture[0]!.fail(failure);
      await settle();
      assert.equal(earlyHost.last('customLogsError')?.message, 'Another client holds the subscription.');

      const late = loadEvents();
      const lateHost = await openEvents(late);
      late.fake.calls.customLogCapture[0]!.report();
      late.fake.calls.customLogCapture[0]!.fail(failure);
      await settle();
      assert.deepEqual(strip(lateHost)?.capture, {
        state: 'failed',
        code: 'CUSTOM_LOG_CLIENT_LIMIT',
        message: 'Another client holds the subscription.'
      });
      await lateHost.emit({ type: 'customLogsCapture', action: 'start' });
      assert.equal(late.fake.calls.customLogCapture.length, 2, 'Start tries again after a failure');
    });

    test('an aborted capture is not a failure', async () => {
      const ctx = loadEvents();
      const host = await openEvents(ctx);

      ctx.fake.calls.customLogCapture[0]!.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await settle();

      assert.equal(host.last('customLogsError')?.message, undefined);
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
