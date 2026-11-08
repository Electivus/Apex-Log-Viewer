import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  withPayloadColumn,
  type CustomLogColumn,
  type CustomLogConfigIssueView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from '@alv/protocol/customLogsTypes';
import type { CustomLogsFromWebviewMessage, CustomLogsToWebviewMessage } from '@alv/protocol/customLogsMessages';
import { initialCustomLogsView, reduceCustomLogsView } from '@alv/protocol/customLogsState';
import type { OrgItem } from '@alv/protocol/types';
import { getMessages } from './i18n';
import { CustomLogRowDetail } from './components/custom-logs/CustomLogRowDetail';
import { CustomLogsCaptureStrip } from './components/custom-logs/CustomLogsCaptureStrip';
import { CustomLogsConfigIssues, CustomLogsEmptyState } from './components/custom-logs/CustomLogsEmptyState';
import { CustomLogsStatusBar } from './components/custom-logs/CustomLogsStatusBar';
import { CustomLogsTable } from './components/custom-logs/CustomLogsTable';
import { CustomLogsToolbar } from './components/custom-logs/CustomLogsToolbar';
import { usePayloadWorkbench } from './components/custom-logs/usePayloadWorkbench';
import { LoadingOverlay } from './components/LoadingOverlay';
import { buildTableColumns, columnSortValue } from './utils/customLogs/columns';
import { fillTemplate, formatCount } from './utils/customLogs/format';
import { countPayloadStates, type DiscoveredField, type PayloadColumn } from './utils/customLogs/payloadRows';
import { rowSearchText, searchItems } from './utils/customLogs/search';
import { filterMenuModel, withFilter, withUsersOf, type FilterKey } from './utils/customLogs/serverFilter';
import { detailDock, readPayloadUiState, useElementHeight } from './utils/customLogs/uiState';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

const NO_CAPABILITIES = { levelFilter: false, userFilter: false };
const NO_ORGS: OrgItem[] = [];
const NO_SOURCES: CustomLogSourceView[] = [];
const NO_ISSUES: CustomLogConfigIssueView[] = [];
const NO_COLUMNS: CustomLogColumn[] = [];
const NO_ROWS: CustomLogRow[] = [];
const NO_FIELDS: CustomLogPayloadField[] = [];

function scopeKeyOf(org: string | undefined, sourceId: string | undefined): string | undefined {
  return org && sourceId ? `${org}|${sourceId}` : undefined;
}

function buildReadyMessage(): CustomLogsFromWebviewMessage {
  const content = document.querySelector('meta[name="alv-mount-sequence"]')?.getAttribute('content');
  const mountSequence = content ? Number.parseInt(content, 10) : Number.NaN;
  return Number.isInteger(mountSequence) && mountSequence >= 0
    ? { type: 'customLogsReady', mountSequence }
    : { type: 'customLogsReady' };
}

export interface CustomLogsAppProps {
  vscode?: VsCodeWebviewApi<CustomLogsFromWebviewMessage>;
  messageBus?: MessageBus;
  virtualListComponent?: React.ComponentProps<typeof CustomLogsTable>['virtualListComponent'];
}

export function CustomLogsApp({
  vscode = getDefaultVsCodeApi<CustomLogsFromWebviewMessage>(),
  messageBus = getDefaultMessageBus(),
  virtualListComponent
}: CustomLogsAppProps = {}) {
  const [initialUiState] = useState(() => readPayloadUiState(vscode.getState()));
  const [view, dispatch] = useReducer(reduceCustomLogsView, initialCustomLogsView);
  const { surface, loading, error, filter: serverFilter, payloadColumns: columnsView } = view;
  const locale = view.locale ?? 'en';
  const orgs = view.orgs?.data ?? NO_ORGS;
  const selectedOrg = view.orgs?.selected;
  const sources = view.sources?.data ?? NO_SOURCES;
  const sourcesReceived = view.sources !== undefined;
  const selectedSourceId = view.sources?.selected;
  const issues = view.sources?.issues ?? NO_ISSUES;
  const extraColumns = view.page?.columns ?? NO_COLUMNS;
  const logColumns = view.page?.logColumns ?? NO_COLUMNS;
  const rows = view.page?.rows ?? NO_ROWS;
  const payloadFields = view.page?.payloadFields ?? NO_FIELDS;
  const hasMore = view.page?.hasMore ?? false;
  const capture = view.capture;
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [rootRef, rootHeight] = useElementHeight<HTMLDivElement>();

  const messages = getMessages(locale);
  const t = messages.customLogs;

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage(buildReadyMessage());
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as CustomLogsToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      dispatch(msg);
    };
    messageBus.addEventListener('message', onMessage as EventListener);
    vscode.postMessage(buildReadyMessage());
    return () => messageBus.removeEventListener('message', onMessage as EventListener);
  }, [messageBus, vscode]);

  const post = useCallback((message: CustomLogsFromWebviewMessage) => vscode.postMessage(message), [vscode]);

  const readySources = useMemo(() => sources.filter(source => source.state === 'ready'), [sources]);
  const selectedSource = useMemo(
    () => sources.find(source => source.id === selectedSourceId),
    [sources, selectedSourceId]
  );
  const sourceReady = selectedSource?.state === 'ready';
  // Every source lists entries, so its entry capabilities decide the Filters and the User column.
  const capabilities = selectedSource?.entryCapabilities ?? NO_CAPABILITIES;

  const onShowColumn = useCallback(
    (path: string, shown: boolean) => {
      dispatch({
        type: 'customLogsPayloadColumns',
        value: { ...columnsView, added: withPayloadColumn(columnsView.added, path, shown) }
      });
      post({ type: 'customLogsShowPayloadColumn', path, shown });
    },
    [columnsView, post]
  );
  const buildColumns = useCallback(
    (payload: PayloadColumn[], discovered: DiscoveredField[]) =>
      buildTableColumns({
        labels: t.columns,
        extra: extraColumns,
        logColumns,
        payload,
        discovered,
        hasOrigin: rows.some(row => row.origin !== undefined),
        hasUser: rows.some(row => row.user !== undefined) || capabilities.userFilter,
        hasLog: rows.some(row => row.log !== undefined)
      }),
    [capabilities.userFilter, extraColumns, logColumns, rows, t.columns]
  );
  const workbench = usePayloadWorkbench({
    initial: initialUiState,
    payloadFields,
    itemCount: rows.length,
    columnsView,
    onShowColumn,
    buildColumns
  });
  const { discovered, activeColumns, lockedColumns, columns, terms } = workbench;

  useEffect(() => {
    vscode.setState(workbench.uiState);
  }, [vscode, workbench.uiState]);

  // The org and source the search, sort, selection and Logged by users belong to: a different one starts with none.
  // The first org and source the host reports are not a change, so a restored webview keeps its saved search.
  const scopeKey = scopeKeyOf(selectedOrg, selectedSourceId);
  const workbenchScope = useRef<string | undefined>(undefined);
  const [seenUsers, setSeenUsers] = useState<readonly string[]>([]);
  useEffect(() => {
    if (scopeKey === undefined) {
      return;
    }
    if (workbenchScope.current !== undefined && workbenchScope.current !== scopeKey) {
      workbench.reset();
      setSelectedId(undefined);
      setSeenUsers([]);
    }
    workbenchScope.current = scopeKey;
  }, [scopeKey, workbench.reset]);

  // Logged by offers the users of every page since the scope began, so picking one keeps the others. This runs
  // after the reset above, so a page that lands with a scope change keeps its users. Rows of the old scope still
  // on screen add none, because only a new page runs it.
  useEffect(() => {
    setSeenUsers(seen => withUsersOf(seen, rows));
  }, [rows]);

  // A switch the user makes moves the workbench to the new source at once, so a search typed while the host
  // confirms it is kept.
  const selectSource = useCallback(
    (sourceId: string) => {
      dispatch({ type: 'customLogsSources', data: sources, selected: sourceId, issues });
      post({ type: 'customLogsSelectSource', sourceId });
      workbenchScope.current = scopeKeyOf(selectedOrg, sourceId);
      workbench.reset();
      setSelectedId(undefined);
      setSeenUsers([]);
    },
    [issues, post, selectedOrg, sources, workbench.reset]
  );

  const visibleRows = useMemo(
    () => workbench.sortItems(searchItems(rows, terms, rowSearchText), columnSortValue),
    [rows, terms, workbench.sortItems]
  );

  const selectedRow = useMemo(() => visibleRows.find(row => row.id === selectedId), [selectedId, visibleRows]);
  const payloadStates = useMemo(() => countPayloadStates(rows), [rows]);

  const dock = detailDock(rootHeight);

  const setServerFilterAndPost = useCallback(
    (filter: CustomLogsFilterView) => {
      dispatch({ type: 'customLogsFilter', value: filter });
      post({ type: 'customLogsSetFilter', filter });
    },
    [post]
  );

  const filters = useMemo(
    () =>
      filterMenuModel({
        filter: serverFilter,
        capabilities,
        users: seenUsers,
        stored: capture !== undefined,
        t: t.filters
      }),
    [capabilities, capture, seenUsers, serverFilter, t.filters]
  );
  const onFilterChange = useCallback(
    (key: FilterKey, value: string) => setServerFilterAndPost(withFilter(serverFilter, key, value)),
    [serverFilter, setServerFilterAndPost]
  );

  const onSelectOrg = (value: string) => {
    dispatch({ type: 'customLogsOrgs', data: orgs, selected: value });
    post({ type: 'customLogsSelectOrg', target: value });
  };

  const messageIfEmpty = (() => {
    if (loading) {
      return undefined;
    }
    if (rows.length === 0) {
      // A store that was never captured is explained by the capture strip, with the choice to fill it.
      return capture?.store.state === 'notCaptured' ? undefined : t.noRows;
    }
    if (visibleRows.length === 0) {
      return [fillTemplate(t.noMatch, { count: rows.length }), hasMore ? t.noMatchMore : ''].filter(Boolean).join(' ');
    }
    return undefined;
  })();

  return (
    <div
      ref={rootRef}
      data-testid="custom-logs-root"
      className="relative flex h-screen min-h-[120px] flex-col overflow-hidden bg-background text-sm text-foreground"
    >
      <CustomLogsToolbar
        t={t}
        orgLabel={messages.orgLabel}
        noOrgsText={messages.noOrgsDetected}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={onSelectOrg}
        sources={readySources}
        selectedSource={selectedSourceId}
        onSelectSource={selectSource}
        search={workbench.search}
        onSearchChange={workbench.setSearch}
        filters={filters}
        onFilterChange={onFilterChange}
        onClearFilters={() => setServerFilterAndPost({})}
        loading={loading}
        showOpenInEditor={surface !== 'editor'}
        onRefresh={() => post({ type: 'customLogsRefresh' })}
        onOpenInEditor={() => post({ type: 'customLogsOpenEditor' })}
        onConfigure={() => post({ type: 'customLogsOpenConfig' })}
      />
      {error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
      {sourcesReceived && !sourceReady ? (
        <CustomLogsEmptyState
          t={t}
          sources={sources}
          issues={issues}
          onConfigure={() => post({ type: 'customLogsOpenConfig' })}
        />
      ) : (
        <>
          {/* A broken source is skipped while another one is ready, so its issues stay visible here too. */}
          <CustomLogsConfigIssues
            t={t}
            issues={issues}
            className="max-h-24 shrink-0 overflow-auto border-b border-border px-3 py-1.5"
          />
          {capture ? (
            <CustomLogsCaptureStrip
              t={t}
              locale={locale}
              sourceLabel={selectedSource?.label ?? ''}
              capture={capture}
              onStop={() => post({ type: 'customLogsCapture', action: 'stop' })}
              onStart={initial =>
                post(
                  initial
                    ? { type: 'customLogsCapture', action: 'start', initial }
                    : { type: 'customLogsCapture', action: 'start' }
                )
              }
            />
          ) : null}
          <div className={dock === 'right' ? 'flex min-h-0 flex-1 flex-row' : 'flex min-h-0 flex-1 flex-col'}>
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {messageIfEmpty ? (
                <p className="m-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {messageIfEmpty}
                </p>
              ) : null}
              <CustomLogsTable
                t={t}
                rows={visibleRows}
                columns={columns}
                sort={workbench.sort}
                selectedId={selectedId}
                discovered={discovered}
                activeColumns={activeColumns}
                lockedColumns={lockedColumns}
                onSort={workbench.onSort}
                onSelect={row => setSelectedId(row.id)}
                onOpen={row => post({ type: 'customLogsOpenLog', logId: row.id })}
                onToggleColumn={workbench.toggleColumn}
                onRemoveColumn={workbench.removeColumn}
                virtualListComponent={virtualListComponent}
              />
              <LoadingOverlay show={loading && rows.length === 0} label={t.loading} />
            </div>
            {selectedRow ? (
              <CustomLogRowDetail
                t={t}
                row={selectedRow}
                logColumns={logColumns}
                dock={dock}
                columns={activeColumns}
                lockedColumns={lockedColumns}
                onClose={() => setSelectedId(undefined)}
                onOpenLog={row => post({ type: 'customLogsOpenLog', logId: row.id })}
                onOpenPayload={row => post({ type: 'customLogsOpenPayload', logId: row.id })}
                onToggleColumn={workbench.toggleColumn}
              />
            ) : null}
          </div>
          <CustomLogsStatusBar
            t={t}
            scope={
              terms.length > 0
                ? [
                    fillTemplate(t.status.searching, {
                      matches: formatCount(visibleRows.length, locale),
                      loaded: formatCount(rows.length, locale)
                    }),
                    hasMore && visibleRows.length < rows.length ? t.status.searchMore : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : rows.length === 1
                  ? t.status.rowsLoadedOne
                  : fillTemplate(t.status.rowsLoaded, { count: formatCount(rows.length, locale) })
            }
            payloadInUse={workbench.payloadInUse}
            hint={capture ? t.status.hintStored : t.status.hint}
            payloadStates={payloadStates}
            hasMore={hasMore}
            loading={loading}
            onLoadMore={() => post({ type: 'customLogsLoadMore' })}
          />
        </>
      )}
    </div>
  );
}

export function mountCustomLogsApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<CustomLogsFromWebviewMessage>; messageBus?: MessageBus } = {}
) {
  const root = createRoot(container);
  root.render(
    <CustomLogsApp
      vscode={options.vscode ?? getDefaultVsCodeApi<CustomLogsFromWebviewMessage>()}
      messageBus={options.messageBus ?? getDefaultMessageBus()}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('root');
  if (host) {
    mountCustomLogsApp(host);
  }
}
