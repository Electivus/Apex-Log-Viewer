import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CUSTOM_LOG_LEVELS,
  mergePayloadFields,
  type CustomLogColumn,
  type CustomLogConfigIssueView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogScalar,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from '@alv/protocol/customLogsTypes';
import type { CustomLogsFromWebviewMessage, CustomLogsToWebviewMessage } from '@alv/protocol/customLogsMessages';
import type { OrgItem } from '@alv/protocol/types';
import { getMessages } from './i18n';
import { CustomLogRowDetail } from './components/custom-logs/CustomLogRowDetail';
import { CustomLogsEmptyState } from './components/custom-logs/CustomLogsEmptyState';
import { CustomLogsFilterBar, type FilterBarPrefill, type FilterChip } from './components/custom-logs/CustomLogsFilterBar';
import { CustomLogsStatusBar } from './components/custom-logs/CustomLogsStatusBar';
import { CustomLogsTable } from './components/custom-logs/CustomLogsTable';
import { CustomLogsToolbar } from './components/custom-logs/CustomLogsToolbar';
import { LoadingOverlay } from './components/LoadingOverlay';
import { buildTableColumns, columnSortValue, type SortState } from './utils/customLogs/columns';
import { describeParseError, describeServerError, type FilterSubmitResult } from './utils/customLogs/filterMessages';
import {
  filterConditionsEqual,
  formatFilterCondition,
  formatFilterValue,
  parseFilterExpression,
  type FilterClause
} from './utils/customLogs/filterGrammar';
import { fillTemplate, formatCount } from './utils/customLogs/format';
import {
  SINCE_QUICK_VALUES,
  applyServerCondition,
  clearServerFilter,
  guidedPayloadFields,
  isServerFilterField,
  serverChips,
  valueCountsToItems,
  type GuidedField,
  type GuidedItem,
  type ServerFilterField
} from './utils/customLogs/guidedFilter';
import {
  countPayloadStates,
  discoverPayloadFields,
  filterLoadedRows,
  payloadValues,
  resolvePayloadColumns,
  sortLoadedRows,
  topValues
} from './utils/customLogs/payloadRows';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

/** Below this panel height the row detail docks to the right; at or above it, under the table. */
const DETAIL_BOTTOM_MIN_HEIGHT_PX = 640;

type CustomLogsUiState = {
  payloadFilters: FilterClause[];
  sort?: SortState;
  hiddenDefaults: string[];
};

const EMPTY_COLUMNS: CustomLogPayloadColumnsView = { defaults: [], added: [] };

function buildReadyMessage(): CustomLogsFromWebviewMessage {
  const content = document.querySelector('meta[name="alv-mount-sequence"]')?.getAttribute('content');
  const mountSequence = content ? Number.parseInt(content, 10) : Number.NaN;
  return Number.isInteger(mountSequence) && mountSequence >= 0
    ? { type: 'customLogsReady', mountSequence }
    : { type: 'customLogsReady' };
}

function readInitialUiState(vscode: VsCodeWebviewApi<CustomLogsFromWebviewMessage>): CustomLogsUiState {
  const raw = vscode.getState<Partial<CustomLogsUiState>>() ?? {};
  const isClause = (value: unknown): value is FilterClause =>
    typeof value === 'object' && value !== null && typeof (value as FilterClause).field === 'string' && typeof (value as FilterClause).op === 'string';
  const sort = raw.sort;
  return {
    payloadFilters: Array.isArray(raw.payloadFilters) ? raw.payloadFilters.filter(isClause) : [],
    sort:
      sort && typeof sort.columnId === 'string' && (sort.dir === 'asc' || sort.dir === 'desc')
        ? { columnId: sort.columnId, dir: sort.dir }
        : undefined,
    hiddenDefaults: Array.isArray(raw.hiddenDefaults) ? raw.hiddenDefaults.filter(path => typeof path === 'string') : []
  };
}

function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      try {
        observer.disconnect();
      } catch (e) {
        console.warn('CustomLogsApp: failed to disconnect ResizeObserver', e);
      }
    };
  }, []);
  return [ref, height];
}

function scalarToFilterValue(value: CustomLogScalar): string {
  return value === null ? 'null' : String(value);
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLowerCase().includes(prefix.toLowerCase());
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
  const [initialUiState] = useState<CustomLogsUiState>(() => readInitialUiState(vscode));
  const [locale, setLocale] = useState('en');
  const [surface, setSurface] = useState<'view' | 'editor'>('view');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [sources, setSources] = useState<CustomLogSourceView[]>([]);
  const [sourcesReceived, setSourcesReceived] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<CustomLogConfigIssueView[]>([]);
  const [serverFilter, setServerFilter] = useState<CustomLogsFilterView>({});
  const [columnsView, setColumnsView] = useState<CustomLogPayloadColumnsView>(EMPTY_COLUMNS);
  const [extraColumns, setExtraColumns] = useState<CustomLogColumn[]>([]);
  const [rows, setRows] = useState<CustomLogRow[]>([]);
  const [payloadFields, setPayloadFields] = useState<CustomLogPayloadField[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [payloadFilters, setPayloadFilters] = useState<FilterClause[]>(initialUiState.payloadFilters);
  const [sort, setSort] = useState<SortState | undefined>(initialUiState.sort);
  const [hiddenDefaults, setHiddenDefaults] = useState<string[]>(initialUiState.hiddenDefaults);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [prefill, setPrefill] = useState<FilterBarPrefill | undefined>(undefined);
  const prefillNonce = useRef(0);
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
      switch (msg.type) {
        case 'customLogsInit':
          setLocale(msg.locale);
          setSurface(msg.surface ?? 'view');
          break;
        case 'customLogsOrgs':
          setOrgs(msg.data || []);
          setSelectedOrg(msg.selected);
          break;
        case 'customLogsSources':
          setSources(msg.data || []);
          setSelectedSourceId(msg.selected);
          setIssues(msg.issues || []);
          setSourcesReceived(true);
          break;
        case 'customLogsFilter':
          setServerFilter(msg.value ?? {});
          break;
        case 'customLogsPayloadColumns':
          setColumnsView(msg.value ?? EMPTY_COLUMNS);
          break;
        case 'customLogsLoading':
          setLoading(!!msg.value);
          break;
        case 'customLogsPage':
          setExtraColumns(msg.columns || []);
          if (msg.mode === 'replace') {
            setRows(msg.rows || []);
            setPayloadFields(msg.payloadFields || []);
          } else {
            setRows(previous => [...previous, ...(msg.rows || [])]);
            setPayloadFields(previous => mergePayloadFields(previous, msg.payloadFields || []));
          }
          setHasMore(!!msg.hasMore);
          break;
        case 'customLogsError':
          setError(msg.message);
          break;
      }
    };
    messageBus.addEventListener('message', onMessage as EventListener);
    vscode.postMessage(buildReadyMessage());
    return () => messageBus.removeEventListener('message', onMessage as EventListener);
  }, [messageBus, vscode]);

  useEffect(() => {
    vscode.setState({ payloadFilters, sort, hiddenDefaults } satisfies CustomLogsUiState);
  }, [hiddenDefaults, payloadFilters, sort, vscode]);

  // What the loaded rows were read from: a different org or source starts with no JSON filters, sort or selection.
  // The first org and source the host reports are not a change, so a restored webview keeps its saved filters.
  const scopeKey = selectedOrg && selectedSourceId ? `${selectedOrg}|${selectedSourceId}` : undefined;
  const previousScopeKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (scopeKey === undefined) {
      return;
    }
    if (previousScopeKey.current !== undefined && previousScopeKey.current !== scopeKey) {
      setPayloadFilters([]);
      setSort(undefined);
      setSelectedId(undefined);
      setHiddenDefaults([]);
    }
    previousScopeKey.current = scopeKey;
  }, [scopeKey]);

  const post = useCallback((message: CustomLogsFromWebviewMessage) => vscode.postMessage(message), [vscode]);

  const readySources = useMemo(() => sources.filter(source => source.state === 'ready'), [sources]);
  const selectedSource = useMemo(() => sources.find(source => source.id === selectedSourceId), [sources, selectedSourceId]);
  const sourceReady = selectedSource?.state === 'ready';

  const discovered = useMemo(() => discoverPayloadFields(payloadFields, rows.length), [payloadFields, rows.length]);
  const payloadColumns = useMemo(() => resolvePayloadColumns(columnsView, hiddenDefaults), [columnsView, hiddenDefaults]);
  const activeColumns = useMemo(() => new Set(payloadColumns.map(column => column.path)), [payloadColumns]);
  const lockedColumns = useMemo(
    () => new Set(payloadColumns.filter(column => column.origin === 'default').map(column => column.path)),
    [payloadColumns]
  );

  const columns = useMemo(
    () =>
      buildTableColumns({
        labels: { time: t.columns.time, level: t.columns.level, title: t.columns.title, user: t.columns.user, counts: t.columns.counts },
        extra: extraColumns,
        payload: payloadColumns,
        discovered,
        hasUser: rows.some(row => row.user !== undefined) || Boolean(selectedSource?.capabilities.userFilter),
        hasCounts: rows.some(row => row.counts !== undefined)
      }),
    [discovered, extraColumns, payloadColumns, rows, selectedSource?.capabilities.userFilter, t.columns]
  );

  useEffect(() => {
    if (sort && !columns.some(column => column.id === sort.columnId)) {
      setSort(undefined);
    }
  }, [columns, sort]);

  const visibleRows = useMemo(() => {
    const filtered = filterLoadedRows(rows, payloadFilters);
    const sortColumn = sort ? columns.find(column => column.id === sort.columnId) : undefined;
    return sort && sortColumn ? sortLoadedRows(filtered, row => columnSortValue(row, sortColumn), sort.dir) : filtered;
  }, [columns, payloadFilters, rows, sort]);

  const selectedRow = useMemo(() => visibleRows.find(row => row.id === selectedId), [selectedId, visibleRows]);
  const payloadStates = useMemo(() => countPayloadStates(rows), [rows]);

  const capabilities = selectedSource?.capabilities ?? { levelFilter: false, userFilter: false, apexLogLink: false };
  const filtering = payloadFilters.length > 0;
  const payloadInUse = filtering || payloadColumns.length > 0 || sort !== undefined;
  const dock = rootHeight >= DETAIL_BOTTOM_MIN_HEIGHT_PX ? 'bottom' : 'right';

  const setServerFilterAndPost = useCallback(
    (filter: CustomLogsFilterView) => {
      setServerFilter(filter);
      post({ type: 'customLogsSetFilter', filter });
    },
    [post]
  );

  const addPayloadFilters = useCallback((clauses: readonly FilterClause[]) => {
    setPayloadFilters(previous => {
      const next = [...previous];
      for (const clause of clauses) {
        if (!next.some(existing => filterConditionsEqual(existing, clause))) {
          next.push(clause);
        }
      }
      return next.length === previous.length ? previous : next;
    });
  }, []);

  const onSubmitFilter = useCallback(
    (text: string): FilterSubmitResult => {
      const parsed = parseFilterExpression(text);
      if (!parsed.ok) {
        return describeParseError(t.errors, parsed.error);
      }
      let workingFilter = serverFilter;
      let nextSource: string | undefined;
      const clauses: FilterClause[] = [];
      for (const condition of parsed.conditions) {
        if (!isServerFilterField(condition.field)) {
          clauses.push({ field: condition.field, op: condition.op, ...(condition.value === undefined ? {} : { value: condition.value }) });
          continue;
        }
        const applied = applyServerCondition(condition, {
          filter: workingFilter,
          capabilities,
          sourceIds: readySources.map(source => source.id)
        });
        if (!applied.ok) {
          return describeServerError(t.errors, applied.error);
        }
        if (applied.apply.kind === 'filter') {
          workingFilter = applied.apply.filter;
        } else {
          nextSource = applied.apply.sourceId;
        }
      }
      if (JSON.stringify(workingFilter) !== JSON.stringify(serverFilter)) {
        setServerFilterAndPost(workingFilter);
      }
      if (nextSource !== undefined && nextSource !== selectedSourceId) {
        post({ type: 'customLogsSelectSource', sourceId: nextSource });
      }
      addPayloadFilters(clauses);
      return { ok: true };
    },
    [addPayloadFilters, capabilities, post, readySources, selectedSourceId, serverFilter, setServerFilterAndPost, t.errors]
  );

  const requestFilterPrefill = useCallback((text: string) => {
    prefillNonce.current += 1;
    setPrefill({ text, nonce: prefillNonce.current });
  }, []);

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
        text: formatFilterCondition(clause),
        field: clause.field,
        op: clause.op,
        value: formatFilterValue(clause.value),
        onRemove: () => setServerFilterAndPost(clearServerFilter(serverFilter, chip.field)),
        onEdit: () => {
          setServerFilterAndPost(clearServerFilter(serverFilter, chip.field));
          return formatFilterCondition(clause);
        }
      });
    }
    payloadFilters.forEach((clause, index) => {
      const remove = () => setPayloadFilters(previous => previous.filter((_, position) => position !== index));
      result.push({
        key: `loaded-${index}-${formatFilterCondition(clause)}`,
        scope: 'loaded',
        text: formatFilterCondition(clause),
        field: clause.field,
        op: clause.op,
        ...(clause.value === undefined ? {} : { value: formatFilterValue(clause.value) }),
        onRemove: remove,
        onEdit: () => {
          remove();
          return formatFilterCondition(clause);
        }
      });
    });
    return result;
  }, [payloadFilters, readySources.length, selectedSource, serverFilter, setServerFilterAndPost]);

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
    (field: string, prefix: string): GuidedItem[] => {
      if (isServerFilterField(field)) {
        const byField: Record<ServerFilterField, () => GuidedItem[]> = {
          level: () => [...CUSTOM_LOG_LEVELS].reverse().map(level => ({ value: level })),
          user: () => valueCountsToItems(topValues(rows, row => (row.user ? [row.user] : []), 30).values),
          since: () => SINCE_QUICK_VALUES.map(value => ({ value })),
          source: () => readySources.map(source => ({ value: source.id }))
        };
        return byField[field]().filter(item => matchesPrefix(item.value, prefix));
      }
      return valueCountsToItems(topValues(visibleRows, row => payloadValues(row.payload, field), 30).values).filter(item =>
        matchesPrefix(item.value, prefix)
      );
    },
    [readySources, rows, visibleRows]
  );

  const toggleColumn = useCallback(
    (path: string) => {
      if (columnsView.defaults.includes(path)) {
        setHiddenDefaults(previous => (previous.includes(path) ? previous.filter(hidden => hidden !== path) : [...previous, path]));
        return;
      }
      const added = columnsView.added.includes(path) ? columnsView.added.filter(column => column !== path) : [...columnsView.added, path];
      setColumnsView(previous => ({ ...previous, added }));
      post({ type: 'customLogsSetPayloadColumns', added });
    },
    [columnsView, post]
  );

  const removeColumn = useCallback(
    (path: string) => {
      if (activeColumns.has(path)) {
        toggleColumn(path);
      }
    },
    [activeColumns, toggleColumn]
  );

  const onSort = useCallback((columnId: string, dir?: 'asc' | 'desc') => {
    setSort(previous => {
      if (dir) {
        return { columnId, dir };
      }
      if (previous?.columnId !== columnId) {
        return { columnId, dir: 'asc' };
      }
      return previous.dir === 'asc' ? { columnId, dir: 'desc' } : undefined;
    });
  }, []);

  const onSelectOrg = (value: string) => {
    setSelectedOrg(value);
    post({ type: 'customLogsSelectOrg', target: value });
  };
  const onSelectSource = (sourceId: string) => {
    setSelectedSourceId(sourceId);
    post({ type: 'customLogsSelectSource', sourceId });
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
        noOrgsText={messages.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={onSelectOrg}
        sources={readySources}
        selectedSource={selectedSourceId}
        onSelectSource={onSelectSource}
        loading={loading}
        showOpenInEditor={surface !== 'editor'}
        onRefresh={() => post({ type: 'customLogsRefresh' })}
        onOpenInEditor={() => post({ type: 'customLogsOpenEditor' })}
        onConfigure={() => post({ type: 'customLogsOpenConfig' })}
      />
      {error ? (
        <div role="alert" className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {sourcesReceived && !sourceReady ? (
        <CustomLogsEmptyState t={t} sources={sources} issues={issues} onConfigure={() => post({ type: 'customLogsOpenConfig' })} />
      ) : (
        <>
          <CustomLogsFilterBar
            t={t}
            chips={chips}
            fields={guidedFields}
            valuesFor={valuesFor}
            onSubmit={onSubmitFilter}
            onAddColumn={path => !activeColumns.has(path) && toggleColumn(path)}
            prefill={prefill}
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
                sort={sort}
                selectedId={selectedId}
                discovered={discovered}
                activeColumns={activeColumns}
                lockedColumns={lockedColumns}
                onSort={onSort}
                onSelect={row => setSelectedId(row.id)}
                onOpen={row => post({ type: 'customLogsOpenLog', logId: row.id })}
                onToggleColumn={toggleColumn}
                onRemoveColumn={removeColumn}
                onFilterBy={path => requestFilterPrefill(`${path} `)}
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
                onToggleColumn={toggleColumn}
                onFilterEqual={(path, value) => addPayloadFilters([{ field: path, op: '=', value: scalarToFilterValue(value) }])}
              />
            ) : null}
          </div>
          <CustomLogsStatusBar
            t={t}
            scope={
              filtering
                ? fillTemplate(t.status.filtering, { loaded: formatCount(rows.length, locale), matches: formatCount(visibleRows.length, locale) })
                : fillTemplate(t.status.rowsLoaded, { count: formatCount(rows.length, locale) })
            }
            filtering={filtering}
            payloadInUse={payloadInUse}
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
