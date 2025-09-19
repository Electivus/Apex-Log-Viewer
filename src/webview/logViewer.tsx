import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '../shared/logViewerMessages';
import { parseLogLines, type ParsedLogEntry, type LogCategory } from './utils/logViewerParser';
import { LogViewerHeader } from './components/log-viewer/LogViewerHeader';
import { LogViewerFilters, type LogFilter } from './components/log-viewer/LogViewerFilters';
import { LogEntryList } from './components/log-viewer/LogEntryList';
import { LogViewerStatusBar } from './components/log-viewer/LogViewerStatusBar';

declare global {
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}

const vscode = acquireVsCodeApi<LogViewerFromWebviewMessage>();

type Metadata = {
  sizeBytes?: number;
  modifiedAt?: string;
};

function mapFilterToCategory(filter: LogFilter): LogCategory | undefined {
  switch (filter) {
    case 'debug':
      return 'debug';
    case 'soql':
      return 'soql';
    case 'dml':
      return 'dml';
    default:
      return undefined;
  }
}

function App() {
  const [fileName, setFileName] = useState('');
  const [locale, setLocale] = useState('en');
  const [metadata, setMetadata] = useState<Metadata | undefined>(undefined);
  const [entries, setEntries] = useState<ParsedLogEntry[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const latestRequestId = useRef(0);

  useEffect(() => {
    const handler = (event: MessageEvent<LogViewerToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'logViewerInit') {
        setLocale(msg.locale || 'en');
        setFileName(msg.fileName);
        setMetadata(msg.metadata);
        if (typeof msg.logUri === 'string' && msg.logUri.length > 0) {
          const requestId = ++latestRequestId.current;
          setLoading(true);
          setError(undefined);
          void fetch(msg.logUri)
            .then(response => {
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
              }
              return response.text();
            })
            .then(text => {
              if (latestRequestId.current !== requestId) {
                return;
              }
              const lines = text.split(/\r?\n/);
              if (lines.length > 0 && lines[lines.length - 1] === '') {
                lines.pop();
              }
              setEntries(parseLogLines(lines));
              setLoading(false);
            })
            .catch(err => {
              if (latestRequestId.current !== requestId) {
                return;
              }
              setEntries([]);
              const message = err instanceof Error ? err.message : String(err);
              setError(`Failed to load log content: ${message}`);
              setLoading(false);
            });
        } else {
          const parsed = parseLogLines(Array.isArray(msg.lines) ? msg.lines : []);
          setEntries(parsed);
          setLoading(false);
          setError(undefined);
        }
      } else if (msg.type === 'logViewerError') {
        setError(msg.message);
        setLoading(false);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'logViewerReady' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const counts = useMemo(() => {
    let debug = 0;
    let soql = 0;
    let dml = 0;
    for (const entry of entries) {
      switch (entry.category) {
        case 'debug':
          debug++;
          break;
        case 'soql':
          soql++;
          break;
        case 'dml':
          dml++;
          break;
      }
    }
    return {
      total: entries.length,
      debug,
      soql,
      dml
    };
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter(entry => {
      switch (filter) {
        case 'debug':
          if (entry.category !== 'debug') return false;
          break;
        case 'soql':
          if (entry.category !== 'soql') return false;
          break;
        case 'dml':
          if (entry.category !== 'dml') return false;
          break;
      }
      if (!needle) {
        return true;
      }
      const haystack = [entry.timestamp, entry.type, entry.message, entry.details, entry.raw]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, search, filter]);

  const highlightCategory = mapFilterToCategory(filter);

  const onViewRaw = () => {
    vscode.postMessage({ type: 'logViewerViewRaw' });
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <LogViewerHeader
        fileName={fileName}
        search={search}
        onSearchChange={setSearch}
        onViewRaw={onViewRaw}
        disabled={loading}
      />
      <LogViewerFilters active={filter} onChange={setFilter} counts={counts} locale={locale} />
      <main className="flex min-h-0 flex-1 flex-col bg-background/40">
        {error ? (
          <div className="m-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : loading ? (
          <div className="m-6 rounded-md border border-border/40 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            Loading log entries…
          </div>
        ) : (
          <LogEntryList entries={filteredEntries} highlightCategory={highlightCategory} />
        )}
      </main>
      <LogViewerStatusBar counts={counts} locale={locale} metadata={metadata} />
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
