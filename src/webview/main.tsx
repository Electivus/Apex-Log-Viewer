import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from './i18n';
import type { OrgItem, ApexLogRow } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { Toolbar } from './components/Toolbar';
import { LogsTable } from './components/LogsTable';
import { LoadingOverlay } from './components/LoadingOverlay';

declare global {
  // Provided by VS Code webview runtime
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}

const vscode = acquireVsCodeApi<WebviewToExtensionMessage>();

type SortKey = 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';

function App() {
  const [locale, setLocale] = useState('en');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);

  const [rows, setRows] = useState<ApexLogRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [logHead, setLogHead] = useState<Record<string, { codeUnitStarted?: string }>>({});

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
        case 'orgs':
          setOrgs(msg.data || []);
          setSelectedOrg(msg.selected);
          break;
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'getOrgs' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const onRefresh = () => {
    vscode.postMessage({ type: 'refresh' });
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
      return hay.includes(q);
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
  }, [rows, query, filterUser, filterOperation, filterStatus, filterCodeUnit, sortBy, sortDir, logHead]);

  const Body = () => {
    const t = useI18n();
    return (
      <div style={{ padding: 8, position: 'relative', minHeight: 120 }}>
        <Toolbar
          loading={loading}
          error={error}
          onRefresh={onRefresh}
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
        />

        <LogsTable
          rows={filteredRows}
          logHead={logHead}
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

        {!loading && filteredRows.length === 0 && (
          <div style={{ marginTop: 12, opacity: 0.8 }}>{t.noLogs}</div>
        )}
      </div>
    );
  };

  return (
    <I18nProvider locale={locale}>
      <Body />
    </I18nProvider>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
