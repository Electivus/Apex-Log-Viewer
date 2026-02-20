import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getMessages, type Messages } from './i18n';
import type { OrgItem, ApexLogRow } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import {
  DEFAULT_LOGS_COLUMNS_CONFIG,
  normalizeLogsColumnsConfig,
  type LogsColumnKey,
  type NormalizedLogsColumnsConfig
} from '../shared/logsColumns';
import { Toolbar } from './components/Toolbar';
import { LogsTable } from './components/LogsTable';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Button } from './components/ui/button';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

type SortKey = Exclude<LogsColumnKey, 'match'>;

export interface LogsAppProps {
  vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>;
  messageBus?: MessageBus;
}

export function LogsApp({
  vscode = getDefaultVsCodeApi<WebviewToExtensionMessage>(),
  messageBus = getDefaultMessageBus()
}: LogsAppProps = {}) {
  const [locale, setLocale] = useState('en');
  const [t, setT] = useState<Messages>(() => getMessages('en'));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [warning, setWarning] = useState<string | undefined>(undefined);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);

  const [rows, setRows] = useState<ApexLogRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [logHead, setLogHead] = useState<Record<string, { codeUnitStarted?: string }>>({});
  const [matchingIds, setMatchingIds] = useState<Set<string>>(new Set());
  const [matchSnippets, setMatchSnippets] = useState<Record<string, { text: string; ranges: [number, number][] }>>({});
  const [fullLogSearchEnabled, setFullLogSearchEnabled] = useState(false);
  const [logsColumns, setLogsColumns] = useState<NormalizedLogsColumnsConfig>(DEFAULT_LOGS_COLUMNS_CONFIG);
  const queryRef = useRef('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading'>('idle');

  // Search + filters
  const [query, setQueryState] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCodeUnit, setFilterCodeUnit] = useState('');

  // Sorting
  const [sortBy, setSortBy] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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
      vscode.postMessage({ type: 'ready' });
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
            [msg.logId]: { codeUnitStarted: msg.codeUnitStarted }
          }));
          break;
        case 'searchMatches': {
          const target = (msg.query ?? '').trim().toLowerCase();
          if (target !== queryRef.current.trim().toLowerCase()) {
            break;
          }
          const ids = Array.isArray(msg.logIds) ? msg.logIds.filter(Boolean) : [];
          setMatchingIds(new Set(ids));
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
    vscode.postMessage({ type: 'ready' });
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
    }
  }, [query]);

  const onRefresh = () => {
    vscode.postMessage({ type: 'refresh' });
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
  }, [rows, query, filterUser, filterOperation, filterStatus, filterCodeUnit, sortBy, sortDir, logHead, matchingIds]);

  const searchLoading = searchStatus === 'loading';
  const searchMessage = searchLoading ? t.searchPreparing ?? t.loading : undefined;

  const hasFilters = Boolean(
    query.trim() ||
      filterUser ||
      filterOperation ||
      filterStatus ||
      filterCodeUnit
  );

  return (
    <div className="relative flex min-h-[120px] flex-col gap-4 p-4 text-sm">
      <Toolbar
        loading={loading}
        error={error}
        warning={warning}
        onRefresh={onRefresh}
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
        onFilterUserChange={setFilterUser}
        onFilterOperationChange={setFilterOperation}
        onFilterStatusChange={setFilterStatus}
        onFilterCodeUnitChange={setFilterCodeUnit}
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
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={onSort}
          matchSnippets={matchSnippets}
          fullLogSearchEnabled={fullLogSearchEnabled}
          autoLoadEnabled={!hasFilters}
          columnsConfig={logsColumns}
          onColumnsConfigChange={onColumnsConfigChange}
        />
        {hasFilters && hasMore && (
          <div className="mt-2 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onLoadMore}
              disabled={loading}
            >
              {t.loadMoreFiltered ?? t.loadMore ?? 'Load more results'}
            </Button>
          </div>
        )}
        <LoadingOverlay show={loading} label={t.loading} />
      </div>

      {!loading && filteredRows.length === 0 && (
        <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {t.noLogs}
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
