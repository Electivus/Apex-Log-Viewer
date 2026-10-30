import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CUSTOM_LOG_LEVELS,
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
import { CustomLogsEmptyState } from './components/custom-logs/CustomLogsEmptyState';
import { CustomLogsFilterBar, type FilterChip } from './components/custom-logs/CustomLogsFilterBar';
import { CustomLogsStatusBar } from './components/custom-logs/CustomLogsStatusBar';
import { CustomLogsTable } from './components/custom-logs/CustomLogsTable';
import { CustomLogsToolbar } from './components/custom-logs/CustomLogsToolbar';
import { usePayloadWorkbench } from './components/custom-logs/usePayloadWorkbench';
import { LoadingOverlay } from './components/LoadingOverlay';
import { buildTableColumns, columnSortValue } from './utils/customLogs/columns';
import { describeParseError, describeServerError, type FilterSubmitResult } from './utils/customLogs/filterMessages';
import {
  formatFilterCondition,
  formatFilterValue,
  isServerFilterField,
  parseFilterExpression,
  serverFieldOf,
  type FilterClause,
  type FilterFieldKind,
  type ServerFilterField
} from './utils/customLogs/filterGrammar';
import { fillTemplate, formatCount } from './utils/customLogs/format';
import {
  SINCE_QUICK_VALUES,
  applyServerCondition,
  clearServerFilter,
  guidedPayloadFields,
  matchesPrefix,
  payloadValueSuggestions,
  serverChips,
  valueCountsToItems,
  type GuidedField,
  type GuidedItem
} from './utils/customLogs/guidedFilter';
import {
  countPayloadStates,
  filterLoadedRows,
  topValues,
  type DiscoveredField,
  type PayloadColumn
} from './utils/customLogs/payloadRows';
import { detailDock, readPayloadUiState, useElementHeight } from './utils/customLogs/uiState';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

const NO_CAPABILITIES = { levelFilter: false, userFilter: false, apexLogLink: false };
const NO_ORGS: OrgItem[] = [];
const NO_SOURCES: CustomLogSourceView[] = [];
const NO_ISSUES: CustomLogConfigIssueView[] = [];
const NO_COLUMNS: CustomLogColumn[] = [];
const NO_ROWS: CustomLogRow[] = [];
const NO_FIELDS: CustomLogPayloadField[] = [];

function scopeKeyOf(org: string | undefined, sourceId: string | undefined): string | undefined {
  return org && sourceId ? `${org}|${sourceId}` : undefined;
}

function sameFilter(a: CustomLogsFilterView, b: CustomLogsFilterView): boolean {
  return a.minLevel === b.minLevel && a.user === b.user && a.since === b.since;
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
  const rows = view.page?.rows ?? NO_ROWS;
  const payloadFields = view.page?.payloadFields ?? NO_FIELDS;
  const hasMore = view.page?.hasMore ?? false;
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

  const onAddedColumns = useCallback(
    (added: string[]) => {
      dispatch({ type: 'customLogsPayloadColumns', value: { ...columnsView, added } });
      post({ type: 'customLogsSetPayloadColumns', added });
    },
    [columnsView, post]
  );
  const buildColumns = useCallback(
    (payload: PayloadColumn[], discovered: DiscoveredField[]) =>
      buildTableColumns({
        labels: {
          time: t.columns.time,
          level: t.columns.level,
          title: t.columns.title,
          user: t.columns.user,
          counts: t.columns.counts
        },
        extra: extraColumns,
        payload,
        discovered,
        hasUser: rows.some(row => row.user !== undefined) || Boolean(selectedSource?.capabilities.userFilter),
        hasCounts: rows.some(row => row.counts !== undefined)
      }),
    [extraColumns, rows, selectedSource?.capabilities.userFilter, t.columns]
  );
  const workbench = usePayloadWorkbench({
    initial: initialUiState,
    payloadFields,
    itemCount: rows.length,
    columnsView,
    onAddedColumns,
    buildColumns
  });
  const { discovered, activeColumns, lockedColumns, columns, payloadFilters, filtering } = workbench;

  useEffect(() => {
    vscode.setState(workbench.uiState);
  }, [vscode, workbench.uiState]);

  // The org and source the JSON filters, sort and selection belong to: a different one starts with none.
  // The first org and source the host reports are not a change, so a restored webview keeps its saved filters.
  const scopeKey = scopeKeyOf(selectedOrg, selectedSourceId);
  const workbenchScope = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scopeKey === undefined) {
      return;
    }
    if (workbenchScope.current !== undefined && workbenchScope.current !== scopeKey) {
      workbench.reset();
      setSelectedId(undefined);
    }
    workbenchScope.current = scopeKey;
  }, [scopeKey, workbench.reset]);

  // A switch the user makes moves the workbench to the new source at once, so the JSON filters typed with it
  // are added after the reset and survive the host's confirmation. The server filter typed with it travels in
  // the same message, so the host queries the new source once, with that filter.
  const selectSource = useCallback(
    (sourceId: string, filter?: CustomLogsFilterView) => {
      dispatch({ type: 'customLogsSources', data: sources, selected: sourceId, issues });
      if (filter) {
        dispatch({ type: 'customLogsFilter', value: filter });
      }
      post({ type: 'customLogsSelectSource', sourceId, ...(filter ? { filter } : {}) });
      workbenchScope.current = scopeKeyOf(selectedOrg, sourceId);
      workbench.reset();
      setSelectedId(undefined);
    },
    [issues, post, selectedOrg, sources, workbench.reset]
  );

  const visibleRows = useMemo(
    () => workbench.sortItems(filterLoadedRows(rows, payloadFilters), columnSortValue),
    [payloadFilters, rows, workbench.sortItems]
  );

  const selectedRow = useMemo(() => visibleRows.find(row => row.id === selectedId), [selectedId, visibleRows]);
  const payloadStates = useMemo(() => countPayloadStates(rows), [rows]);

  const capabilities = selectedSource?.capabilities ?? NO_CAPABILITIES;
  const dock = detailDock(rootHeight);

  const setServerFilterAndPost = useCallback(
    (filter: CustomLogsFilterView) => {
      dispatch({ type: 'customLogsFilter', value: filter });
      post({ type: 'customLogsSetFilter', filter });
    },
    [post]
  );

  const onSubmitFilter = useCallback(
    (text: string): FilterSubmitResult => {
      const parsed = parseFilterExpression(text);
      if (!parsed.ok) {
        return describeParseError(t.errors, parsed.error);
      }
      // A `source` clause decides which source the other clauses are checked against, so it goes first.
      const conditions = [...parsed.conditions].sort(
        (a, b) => Number(serverFieldOf(b) === 'source') - Number(serverFieldOf(a) === 'source')
      );
      let destination = selectedSource;
      let workingFilter = serverFilter;
      const clauses: FilterClause[] = [];
      for (const condition of conditions) {
        if (!serverFieldOf(condition)) {
          clauses.push({
            field: condition.field,
            op: condition.op,
            ...(condition.value === undefined ? {} : { value: condition.value })
          });
          continue;
        }
        const applied = applyServerCondition(condition, {
          filter: workingFilter,
          capabilities: destination?.capabilities ?? NO_CAPABILITIES,
          sourceIds: readySources.map(source => source.id)
        });
        if (!applied.ok) {
          return describeServerError(t.errors, applied.error);
        }
        if (applied.apply.kind === 'filter') {
          workingFilter = applied.apply.filter;
        } else {
          const sourceId = applied.apply.sourceId;
          destination = readySources.find(source => source.id === sourceId);
        }
      }
      if (destination && destination.id !== selectedSourceId) {
        selectSource(destination.id, workingFilter);
      } else if (!sameFilter(workingFilter, serverFilter)) {
        setServerFilterAndPost(workingFilter);
      }
      workbench.addPayloadFilters(clauses);
      return { ok: true };
    },
    [
      workbench.addPayloadFilters,
      readySources,
      selectSource,
      selectedSource,
      selectedSourceId,
      serverFilter,
      setServerFilterAndPost,
      t.errors
    ]
  );

  const chips = useMemo<FilterChip[]>(() => {
    const result: FilterChip[] = [];
    if (readySources.length > 1 && selectedSource) {
      result.push({
        key: 'source',
        scope: 'server',
        text: `source = ${selectedSource.id}`,
        field: 'source',
        op: '=',
        value: selectedSource.id
      });
    }
    for (const chip of serverChips(serverFilter)) {
      const clause = { field: chip.field, op: chip.op, value: chip.value };
      result.push({
        key: `server-${chip.field}`,
        scope: 'server',
        text: formatFilterCondition(clause, 'server'),
        field: clause.field,
        op: clause.op,
        value: formatFilterValue(clause.value),
        onRemove: () => setServerFilterAndPost(clearServerFilter(serverFilter, chip.field)),
        onEdit: () => {
          setServerFilterAndPost(clearServerFilter(serverFilter, chip.field));
          return formatFilterCondition(clause, 'server');
        }
      });
    }
    result.push(...workbench.loadedChips);
    return result;
  }, [readySources.length, selectedSource, serverFilter, setServerFilterAndPost, workbench.loadedChips]);

  const guidedFields = useMemo<GuidedField[]>(() => {
    const server: GuidedField[] = [];
    if (capabilities.levelFilter) {
      server.push({ path: 'level', kind: 'server' });
    }
    if (capabilities.userFilter) {
      server.push({ path: 'user', kind: 'server' });
    }
    server.push({ path: 'since', kind: 'server' });
    if (readySources.length > 1) {
      server.push({ path: 'source', kind: 'server' });
    }
    return [...server, ...guidedPayloadFields(discovered, activeColumns)];
  }, [activeColumns, capabilities.levelFilter, capabilities.userFilter, discovered, readySources.length]);

  const valuesFor = useCallback(
    (field: string, prefix: string, kind: FilterFieldKind): GuidedItem[] => {
      if (kind === 'server' && isServerFilterField(field)) {
        const byField: Record<ServerFilterField, () => GuidedItem[]> = {
          level: () => [...CUSTOM_LOG_LEVELS].reverse().map(level => ({ value: level })),
          user: () => valueCountsToItems(topValues(rows, row => (row.user ? [row.user] : []), 30).values),
          since: () => SINCE_QUICK_VALUES.map(value => ({ value })),
          source: () => readySources.map(source => ({ value: source.id }))
        };
        return byField[field]().filter(item => matchesPrefix(item.value, prefix));
      }
      return payloadValueSuggestions(visibleRows, field, prefix);
    },
    [readySources, rows, visibleRows]
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
      return t.noRows;
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
          <CustomLogsFilterBar
            t={t}
            chips={chips}
            fields={guidedFields}
            valuesFor={valuesFor}
            onSubmit={onSubmitFilter}
            onAddColumn={path => !activeColumns.has(path) && workbench.toggleColumn(path)}
            prefill={workbench.prefill}
          />
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
                onFilterBy={workbench.prefillFilterField}
                virtualListComponent={virtualListComponent}
              />
              <LoadingOverlay show={loading && rows.length === 0} label={t.loading} />
            </div>
            {selectedRow ? (
              <CustomLogRowDetail
                t={t}
                row={selectedRow}
                dock={dock}
                columns={activeColumns}
                lockedColumns={lockedColumns}
                onClose={() => setSelectedId(undefined)}
                onOpenLog={row => post({ type: 'customLogsOpenLog', logId: row.id })}
                onOpenPayload={row => post({ type: 'customLogsOpenPayload', logId: row.id })}
                onToggleColumn={workbench.toggleColumn}
                onFilterEqual={workbench.filterEqual}
              />
            ) : null}
          </div>
          <CustomLogsStatusBar
            t={t}
            scope={
              filtering
                ? fillTemplate(t.status.filtering, {
                    loaded: formatCount(rows.length, locale),
                    matches: formatCount(visibleRows.length, locale)
                  })
                : rows.length === 1
                  ? t.status.rowsLoadedOne
                  : fillTemplate(t.status.rowsLoaded, { count: formatCount(rows.length, locale) })
            }
            filtering={filtering}
            payloadInUse={workbench.payloadInUse}
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
