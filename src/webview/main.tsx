import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getMessages, type Messages } from './i18n';
import type { OrgItem, ApexLogRow } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { Toolbar } from './components/Toolbar';
import { LogsTable } from './components/LogsTable';
import { LoadingOverlay } from './components/LoadingOverlay';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

type SortKey = 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';

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
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);

  const [rows, setRows] = useState<ApexLogRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [logHead, setLogHead] = useState<Record<string, { codeUnitStarted?: string }>>({});
  const [logSearchContent, setLogSearchContent] = useState<Record<string, string>>({});
  const [prefetchLogBodies, setPrefetchLogBodies] = useState(false);
  const prefetchRef = useRef(prefetchLogBodies);

  // Search + filters
  const [query, setQuery] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCodeUnit, setFilterCodeUnit] = useState('');

  // Sorting
  const [sortBy, setSortBy] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    prefetchRef.current = prefetchLogBodies;
  }, [prefetchLogBodies]);

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
        case 'init':
          setLocale(msg.locale);
          setT(getMessages(msg.locale));
          break;
        case 'logs':
          setRows(msg.data || []);
          setHasMore(!!msg.hasMore);
          setError(undefined);
          setLogHead(prev => {
            const data = msg.data || [];
            if (!data.length) {
              return {};
            }
            const next: typeof prev = {};
            for (const row of data) {
              const existing = row?.Id ? prev[row.Id] : undefined;
              if (row?.Id && existing) {
                next[row.Id] = existing;
              }
            }
            return next;
          });
          setLogSearchContent({});
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
        case 'logSearchContent': {
          if (!prefetchRef.current) {
            break;
          }
          const normalized = (msg.content || '').toLowerCase();
          setLogSearchContent(prev => {
            if (prev[msg.logId] === normalized) {
              return prev;
            }
            return {
              ...prev,
              [msg.logId]: normalized
            };
          });
          break;
        }
        case 'prefetchState':
          setPrefetchLogBodies(msg.value);
          if (!msg.value) {
            setLogSearchContent({});
          }
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

  const onRefresh = () => {
    vscode.postMessage({ type: 'refresh' });
  };
  const onTogglePrefetch = (value: boolean) => {
    vscode.postMessage({ type: 'setPrefetchLogBodies', value });
  };
  const onSelectOrg = (v: string) => {
    setSelectedOrg(v);
    vscode.postMessage({ type: 'selectOrg', target: v });
  };
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
    setQuery('');
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
      const hay = [
        r.LogUser?.Name || '',
        r.Application || '',
        r.Operation || '',
        r.Status || '',
        String(r.LogLength || ''),
        logHead[r.Id]?.codeUnitStarted || ''
      ]
        .join(' ')
        .toLowerCase();
      if (hay.includes(q)) {
        return true;
      }
      const bodyIndex = logSearchContent[r.Id];
      return bodyIndex ? bodyIndex.includes(q) : false;
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
  }, [
    rows,
    query,
    filterUser,
    filterOperation,
    filterStatus,
    filterCodeUnit,
    sortBy,
    sortDir,
    logHead,
    logSearchContent
  ]);

  return (
    <div className="relative flex min-h-[120px] flex-col gap-4 p-4 text-sm">
      <Toolbar
        loading={loading}
        error={error}
        onRefresh={onRefresh}
        t={t}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={onSelectOrg}
        query={query}
        onQueryChange={setQuery}
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
        prefetchLogBodies={prefetchLogBodies}
        onPrefetchChange={onTogglePrefetch}
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
        />
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
