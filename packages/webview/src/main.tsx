import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { getMessages, type Messages } from './i18n';
import type { OrgItem, ApexLogRow } from '../../../apps/vscode-extension/src/shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../apps/vscode-extension/src/shared/messages';
import { bucketQueryLength } from '../../../apps/vscode-extension/src/shared/telemetryBuckets';
import {
  DEFAULT_LOGS_COLUMNS_CONFIG,
  normalizeLogsColumnsConfig,
  type LogsColumnKey,
  type NormalizedLogsColumnsConfig
} from '../../../apps/vscode-extension/src/shared/logsColumns';
import { Toolbar } from './components/Toolbar';
import { LogsTable } from './components/LogsTable';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Button } from './components/ui/button';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';
import type { LogHeadMap } from './components/LogsTable';

type SortKey = Exclude<LogsColumnKey, 'match'>;

interface LogsUiState {
  query: string;
  filterUser: string;
  filterOperation: string;
  filterStatus: string;
  filterCodeUnit: string;
  errorsOnly: boolean;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
}

function buildReadyMessage(): WebviewToExtensionMessage {
  const content = document.querySelector('meta[name="alv-mount-sequence"]')?.getAttribute('content');
  const mountSequence = content ? Number.parseInt(content, 10) : Number.NaN;
  return Number.isInteger(mountSequence) && mountSequence >= 0 ? { type: 'ready', mountSequence } : { type: 'ready' };
}

function readInitialUiState(vscode: VsCodeWebviewApi<WebviewToExtensionMessage>): LogsUiState {
  const raw = vscode.getState<Partial<LogsUiState>>() ?? {};
  const sortBy = raw.sortBy;
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    filterUser: typeof raw.filterUser === 'string' ? raw.filterUser : '',
    filterOperation: typeof raw.filterOperation === 'string' ? raw.filterOperation : '',
    filterStatus: typeof raw.filterStatus === 'string' ? raw.filterStatus : '',
    filterCodeUnit: typeof raw.filterCodeUnit === 'string' ? raw.filterCodeUnit : '',
    errorsOnly: raw.errorsOnly === true,
    sortBy:
      sortBy === 'user' ||
      sortBy === 'application' ||
      sortBy === 'operation' ||
      sortBy === 'time' ||
      sortBy === 'duration' ||
      sortBy === 'status' ||
      sortBy === 'size' ||
      sortBy === 'codeUnit'
        ? sortBy
        : 'time',
    sortDir: raw.sortDir === 'asc' ? 'asc' : 'desc'
  };
}

export interface LogsAppProps {
  vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>;
  messageBus?: MessageBus;
}

export function LogsApp({
  vscode = getDefaultVsCodeApi<WebviewToExtensionMessage>(),
  messageBus = getDefaultMessageBus()
}: LogsAppProps = {}) {
  const [initialUiState] = useState<LogsUiState>(() => readInitialUiState(vscode));
  const initialUiStateRef = useRef<LogsUiState>(initialUiState);
  const [locale, setLocale] = useState('en');
  const [t, setT] = useState<Messages>(() => getMessages('en'));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [warning, setWarning] = useState<string | undefined>(undefined);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);

  const [rows, setRows] = useState<ApexLogRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [logHead, setLogHead] = useState<LogHeadMap>({});
  const [errorScanStatus, setErrorScanStatus] = useState<{
    state: 'idle' | 'running';
    processed: number;
    total: number;
    errorsFound: number;
  }>({
    state: 'idle',
    processed: 0,
    total: 0,
    errorsFound: 0
  });
  const [matchingIds, setMatchingIds] = useState<Set<string>>(new Set());
  const [matchSnippets, setMatchSnippets] = useState<Record<string, { text: string; ranges: [number, number][] }>>({});
  const [fullLogSearchEnabled, setFullLogSearchEnabled] = useState(false);
  const [logsColumns, setLogsColumns] = useState<NormalizedLogsColumnsConfig>(DEFAULT_LOGS_COLUMNS_CONFIG);
  const queryRef = useRef('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading'>('idle');
  const [pendingLogCount, setPendingLogCount] = useState(0);
  const lastTrackedSearchRef = useRef<string | undefined>(undefined);
  const lastTrackedFilterStateRef = useRef<string | undefined>(undefined);

  // Search + filters
  const [query, setQueryState] = useState(initialUiStateRef.current.query);
  const [filterUser, setFilterUser] = useState(initialUiStateRef.current.filterUser);
  const [filterOperation, setFilterOperation] = useState(initialUiStateRef.current.filterOperation);
  const [filterStatus, setFilterStatus] = useState(initialUiStateRef.current.filterStatus);
  const [filterCodeUnit, setFilterCodeUnit] = useState(initialUiStateRef.current.filterCodeUnit);
  const [errorsOnly, setErrorsOnly] = useState(initialUiStateRef.current.errorsOnly);

  // Sorting
  const [sortBy, setSortBy] = useState<SortKey>(initialUiStateRef.current.sortBy);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialUiStateRef.current.sortDir);

  const loadMoreFooterRef = useRef<HTMLDivElement | null>(null);
  const [loadMoreFooterHeightPx, setLoadMoreFooterHeightPx] = useState(0);

  const onColumnsConfigChange = useCallback(
    (updater: (prev: NormalizedLogsColumnsConfig) => NormalizedLogsColumnsConfig, options?: { persist?: boolean }) => {
      setLogsColumns(prev => {
        const next = updater(prev);
        if (options?.persist === false) {
          return next;
        }
        if (messageBus) {
          vscode.postMessage({ type: 'setLogsColumns', value: next });
        }
        return next;
      });
    },
    [messageBus, vscode]
  );

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage(buildReadyMessage());
      return;
    }
    const onMsg = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      switch (msg.type) {
        case 'loading':
          setLoading(!!msg.value);
          break;
        case 'error':
          setError(msg.message);
          break;
        case 'warning':
          setWarning(msg.message);
          break;
        case 'init':
          setLocale(msg.locale);
          setT(getMessages(msg.locale));
          setFullLogSearchEnabled(!!msg.fullLogSearchEnabled);
          if (msg.logsColumns) {
            setLogsColumns(normalizeLogsColumnsConfig(msg.logsColumns));
          }
          break;
        case 'logsColumns':
          setLogsColumns(normalizeLogsColumnsConfig(msg.value));
          break;
        case 'logs':
          setRows(msg.data || []);
          setHasMore(!!msg.hasMore);
          setError(undefined);
          break;
        case 'appendLogs':
          setRows(prev => [...prev, ...(msg.data || [])]);
          setHasMore(!!msg.hasMore);
          break;
        case 'logHead':
          setLogHead(prev => ({
            ...prev,
            [msg.logId]: {
              ...prev[msg.logId],
              ...(msg.codeUnitStarted !== undefined ? { codeUnitStarted: msg.codeUnitStarted } : {}),
              ...(msg.hasErrors !== undefined ? { hasErrors: msg.hasErrors } : {}),
              ...(msg.primaryReason !== undefined ? { primaryReason: msg.primaryReason } : {}),
              ...(msg.reasons !== undefined ? { reasons: msg.reasons } : {})
            }
          }));
          break;
        case 'errorScanStatus':
          setErrorScanStatus({
            state: msg.state,
            processed: msg.processed,
            total: msg.total,
            errorsFound: msg.errorsFound
          });
          break;
        case 'searchMatches': {
          const target = (msg.query ?? '').trim().toLowerCase();
          if (target !== queryRef.current.trim().toLowerCase()) {
            break;
          }
          const ids = Array.isArray(msg.logIds) ? msg.logIds.filter(Boolean) : [];
          const pending = Array.isArray(msg.pendingLogIds) ? msg.pendingLogIds.filter(Boolean) : [];
          setMatchingIds(new Set(ids));
          setPendingLogCount(pending.length);
          if (msg.snippets && typeof msg.snippets === 'object') {
            setMatchSnippets(msg.snippets);
          } else {
            setMatchSnippets({});
          }
          break;
        }
        case 'searchStatus':
          setSearchStatus(msg.state === 'loading' ? 'loading' : 'idle');
          break;
        case 'orgs':
          setOrgs(msg.data || []);
          setSelectedOrg(msg.selected);
          break;
      }
    };
    messageBus.addEventListener('message', onMsg as EventListener);
    vscode.postMessage(buildReadyMessage());
    return () => messageBus.removeEventListener('message', onMsg as EventListener);
  }, [messageBus, vscode]);

  const updateQuery = useCallback(
    (value: string) => {
      const next = value ?? '';
      queryRef.current = next;
      setMatchSnippets({});
      if (!next.trim()) {
        setMatchingIds(new Set());
        setMatchSnippets({});
        setPendingLogCount(0);
      }
      setQueryState(next);
      if (messageBus) {
        vscode.postMessage({ type: 'searchQuery', value: next });
      }
    },
    [messageBus, setMatchingIds, setQueryState, vscode]
  );

  useEffect(() => {
    queryRef.current = query;
    if (!query.trim()) {
      setMatchingIds(new Set());
      setPendingLogCount(0);
    }
  }, [query]);

  useEffect(() => {
    vscode.setState({
      query,
      filterUser,
      filterOperation,
      filterStatus,
      filterCodeUnit,
      errorsOnly,
      sortBy,
      sortDir
    } satisfies LogsUiState);
  }, [errorsOnly, filterCodeUnit, filterOperation, filterStatus, filterUser, query, sortBy, sortDir, vscode]);

  useEffect(() => {
    if (!messageBus) {
      return;
    }
    const normalized = query.trim();
    const previousTracked = lastTrackedSearchRef.current;
    const timeout = window.setTimeout(() => {
      if (!normalized) {
        if (!previousTracked) {
          lastTrackedSearchRef.current = '';
          return;
        }
        vscode.postMessage({ type: 'trackLogsSearch', outcome: 'cleared' });
        lastTrackedSearchRef.current = '';
        return;
      }

      const nextTracked = normalized.toLowerCase();
      if (previousTracked === nextTracked) {
        return;
      }
      const queryLength = bucketQueryLength(normalized);
      if (queryLength === '0') {
        return;
      }

      vscode.postMessage({
        type: 'trackLogsSearch',
        outcome: 'searched',
        queryLength
      });
      lastTrackedSearchRef.current = nextTracked;
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [messageBus, query, vscode]);

  useEffect(() => {
    if (!messageBus) {
      return;
    }
    const rawState = JSON.stringify({
      filterUser,
      filterOperation,
      filterStatus,
      filterCodeUnit,
      errorsOnly
    });
    const previousTracked = lastTrackedFilterStateRef.current;
    if (previousTracked === undefined) {
      lastTrackedFilterStateRef.current = rawState;
      return;
    }
    if (previousTracked === rawState) {
      return;
    }

    const hasUser = Boolean(filterUser);
    const hasOperation = Boolean(filterOperation);
    const hasStatus = Boolean(filterStatus);
    const hasCodeUnit = Boolean(filterCodeUnit);
    const activeCount = [hasUser, hasOperation, hasStatus, hasCodeUnit, errorsOnly].filter(Boolean).length;

    vscode.postMessage({
      type: 'trackLogsFilter',
      outcome: activeCount === 0 ? 'cleared' : 'changed',
      hasUser,
      hasOperation,
      hasStatus,
      hasCodeUnit,
      errorsOnly,
      activeCount
    });
    lastTrackedFilterStateRef.current = rawState;
  }, [errorsOnly, filterCodeUnit, filterOperation, filterStatus, filterUser, messageBus, vscode]);

  const onRefresh = () => {
    vscode.postMessage({ type: 'refresh' });
  };
  const onDownloadAllLogs = () => {
    vscode.postMessage({ type: 'downloadAllLogs' });
  };
  const onClearLogs = (scope: 'all' | 'mine') => {
    vscode.postMessage({ type: 'clearLogs', scope });
  };
  const onSelectOrg = (v: string) => {
    setSelectedOrg(v);
    vscode.postMessage({ type: 'selectOrg', target: v });
  };
  const onOpenDebugFlags = () => vscode.postMessage({ type: 'openDebugFlags' });
  const onOpen = (logId: string) => vscode.postMessage({ type: 'openLog', logId });
  const onReplay = (logId: string) => vscode.postMessage({ type: 'replay', logId });
  const onLoadMore = () => hasMore && vscode.postMessage({ type: 'loadMore' });

  const onSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      // sensible defaults
      setSortDir(key === 'time' || key === 'size' || key === 'duration' ? 'desc' : 'asc');
    }
  };

  const clearFilters = () => {
    updateQuery('');
    setFilterUser('');
    setFilterOperation('');
    setFilterStatus('');
    setFilterCodeUnit('');
    setErrorsOnly(false);
  };

  // Compute filter options
  const users = useMemo(() => Array.from(new Set(rows.map(r => r.LogUser?.Name || ''))).filter(Boolean), [rows]);
  const operations = useMemo(() => Array.from(new Set(rows.map(r => r.Operation || ''))).filter(Boolean), [rows]);
  const statuses = useMemo(() => Array.from(new Set(rows.map(r => r.Status || ''))).filter(Boolean), [rows]);
  const codeUnits = useMemo(
    () => Array.from(new Set(Object.values(logHead).map(h => h.codeUnitStarted || ''))).filter(Boolean),
    [logHead]
  );

  // Apply search + filters + sorting
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = rows.filter(r => {
      if (filterUser && (r.LogUser?.Name || '') !== filterUser) {
        return false;
      }
      if (filterOperation && r.Operation !== filterOperation) {
        return false;
      }
      if (filterStatus && r.Status !== filterStatus) {
        return false;
      }
      if (filterCodeUnit && (logHead[r.Id]?.codeUnitStarted || '') !== filterCodeUnit) {
        return false;
      }
      if (errorsOnly && logHead[r.Id]?.hasErrors !== true) {
        return false;
      }
      if (!q) {
        return true;
      }
      const metadataHaystack = [
        r.LogUser?.Name || '',
        r.Application || '',
        r.Operation || '',
        r.Status || '',
        String(r.LogLength || ''),
        logHead[r.Id]?.codeUnitStarted || ''
      ]
        .join(' ')
        .toLowerCase();
      if (metadataHaystack.includes(q)) {
        return true;
      }
      if (matchingIds.has(r.Id)) {
        return true;
      }
      return false;
    });

    const compare = (a: ApexLogRow, b: ApexLogRow) => {
      let cmp = 0;
      switch (sortBy) {
        case 'user':
          cmp = (a.LogUser?.Name || '').localeCompare(b.LogUser?.Name || '');
          break;
        case 'application':
          cmp = (a.Application || '').localeCompare(b.Application || '');
          break;
        case 'operation':
          cmp = (a.Operation || '').localeCompare(b.Operation || '');
          break;
        case 'time':
          cmp = new Date(a.StartTime).getTime() - new Date(b.StartTime).getTime();
          break;
        case 'duration':
          cmp = (a.DurationMilliseconds || 0) - (b.DurationMilliseconds || 0);
          break;
        case 'status':
          cmp = (a.Status || '').localeCompare(b.Status || '');
          break;
        case 'size':
          cmp = (a.LogLength || 0) - (b.LogLength || 0);
          break;
        case 'codeUnit':
          cmp = (logHead[a.Id]?.codeUnitStarted || '').localeCompare(logHead[b.Id]?.codeUnitStarted || '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    };

    return items.slice().sort(compare);
  }, [rows, query, filterUser, filterOperation, filterStatus, filterCodeUnit, errorsOnly, sortBy, sortDir, logHead, matchingIds]);

  const searchLoading = searchStatus === 'loading';
  const searchMessage = useMemo(() => {
    if (searchLoading) {
      return t.searchPreparing ?? t.loading;
    }
    if (pendingLogCount <= 0) {
      return undefined;
    }
    const template =
      pendingLogCount === 1
        ? (t.searchPending ?? 'Waiting for {count} log to finish downloading…')
        : (t.searchPendingPlural ?? 'Waiting for {count} logs to finish downloading…');
    return template.replace('{count}', String(pendingLogCount));
  }, [pendingLogCount, searchLoading, t]);

  const hasFilters = Boolean(
    query.trim() ||
      filterUser ||
      filterOperation ||
      filterStatus ||
      filterCodeUnit ||
      errorsOnly
  );
  const errorScanMessage = useMemo(() => {
    if (errorScanStatus.state !== 'running') {
      return undefined;
    }
    const template = t.filters?.scanningErrorsProgress ?? 'Scanning logs for errors… ({processed}/{total}, found: {errorsFound})';
    if (errorScanStatus.total <= 0) {
      return t.filters?.scanningErrors ?? 'Scanning logs for errors…';
    }
    return template
      .replace('{processed}', String(errorScanStatus.processed))
      .replace('{total}', String(errorScanStatus.total))
      .replace('{errorsFound}', String(errorScanStatus.errorsFound));
  }, [errorScanStatus, t]);
  const noLogsMessage = errorsOnly && errorScanStatus.state === 'running'
      ? (errorScanMessage ?? t.noLogs)
      : t.noLogs;

  useLayoutEffect(() => {
    if (!hasMore) {
      setLoadMoreFooterHeightPx(0);
      return;
    }
    const el = loadMoreFooterRef.current;
    if (!el) {
      setLoadMoreFooterHeightPx(0);
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const next = rect && Number.isFinite(rect.height) ? Math.max(0, Math.floor(rect.height)) : 0;
      setLoadMoreFooterHeightPx(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogsApp: failed to disconnect ResizeObserver', e);
      }
    };
  }, [hasMore, hasFilters, locale]);

  const viewportBottomInsetPx = hasMore ? Math.max(loadMoreFooterHeightPx, 42) : 0;

  return (
    <div className="relative flex min-h-[120px] flex-col gap-4 p-4 text-sm">
      <Toolbar
        loading={loading}
        error={error}
        warning={warning}
        onRefresh={onRefresh}
        onDownloadAllLogs={onDownloadAllLogs}
        onClearLogs={onClearLogs}
        onOpenDebugFlags={onOpenDebugFlags}
        t={t}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={onSelectOrg}
        query={query}
        onQueryChange={updateQuery}
        searchLoading={searchLoading}
        searchMessage={searchMessage}
        users={users}
        operations={operations}
        statuses={statuses}
        codeUnits={codeUnits}
        filterUser={filterUser}
        filterOperation={filterOperation}
        filterStatus={filterStatus}
        filterCodeUnit={filterCodeUnit}
        errorsOnly={errorsOnly}
        onFilterUserChange={setFilterUser}
        onFilterOperationChange={setFilterOperation}
        onFilterStatusChange={setFilterStatus}
        onFilterCodeUnitChange={setFilterCodeUnit}
        onErrorsOnlyChange={setErrorsOnly}
        onClearFilters={clearFilters}
        columnsConfig={logsColumns}
        fullLogSearchEnabled={fullLogSearchEnabled}
        onColumnsConfigChange={onColumnsConfigChange}
      />

      <div className="relative rounded-lg border border-border bg-card/60 p-2">
        <LogsTable
          rows={filteredRows}
          logHead={logHead}
          t={t}
          onOpen={onOpen}
          onReplay={onReplay}
          loading={loading}
          locale={locale}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={onSort}
          matchSnippets={matchSnippets}
          fullLogSearchEnabled={fullLogSearchEnabled}
          viewportBottomInsetPx={viewportBottomInsetPx}
          columnsConfig={logsColumns}
          onColumnsConfigChange={onColumnsConfigChange}
        />
        {hasMore && (
          <div ref={loadMoreFooterRef} className="flex justify-center pt-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onLoadMore}
              disabled={loading}
            >
              {hasFilters
                ? (t.loadMoreFiltered ?? t.loadMore ?? 'Load more results')
                : (t.loadMore ?? 'Load more logs')}
            </Button>
          </div>
        )}
        <LoadingOverlay show={loading} label={t.loading} />
      </div>
      {errorScanMessage && (
        <p className="text-xs text-muted-foreground">{errorScanMessage}</p>
      )}

      {!loading && filteredRows.length === 0 && (
        <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {noLogsMessage}
        </p>
      )}
    </div>
  );
}

export function mountLogsApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>; messageBus?: MessageBus } = {}
) {
  const root = createRoot(container);
  const messageBus = options.messageBus ?? getDefaultMessageBus();
  root.render(
    <LogsApp
      vscode={options.vscode ?? getDefaultVsCodeApi<WebviewToExtensionMessage>()}
      messageBus={messageBus}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('root');
  if (host) {
    mountLogsApp(host);
  }
}
