import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  LogViewerFromWebviewMessage,
  LogViewerToWebviewMessage,
  LogViewerTriagePayload
} from '../shared/logViewerMessages';
import { parseLogLines, type ParsedLogEntry, type LogCategory } from './utils/logViewerParser';
import { LogViewerHeader } from './components/log-viewer/LogViewerHeader';
import { LogViewerFilters, type LogFilter } from './components/log-viewer/LogViewerFilters';
import { LogEntryList } from './components/log-viewer/LogEntryList';
import { LogDiagnosticsSidebar } from './components/log-viewer/LogDiagnosticsSidebar';
import { LogViewerStatusBar } from './components/log-viewer/LogViewerStatusBar';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';
import type { ListImperativeAPI } from 'react-window';
import type { LogViewerMappedDiagnostic } from './utils/logViewerDiagnostics';
import { buildVisibleEntries, mapDiagnosticsToEntries } from './utils/logViewerDiagnostics';

type TriageState = 'loading' | 'unavailable' | 'empty' | 'ready';
type DiagnosticSeverityFilter = 'all' | 'error' | 'warning';

type Metadata = {
  sizeBytes?: number;
  modifiedAt?: string;
};

function mapFilterToCategory(filter: LogFilter): LogCategory | undefined {
  switch (filter) {
    case 'debug':
      return 'debug';
    case 'error':
      return 'error';
    case 'soql':
      return 'soql';
    case 'dml':
      return 'dml';
    default:
      return undefined;
  }
}

function getResolvedTriageState(triage: LogViewerTriagePayload): Exclude<TriageState, 'loading' | 'unavailable'> {
  return triage.reasons?.length || triage.primaryReason?.trim() ? 'ready' : 'empty';
}

export interface LogViewerAppProps {
  vscode?: VsCodeWebviewApi<LogViewerFromWebviewMessage>;
  messageBus?: MessageBus;
  fetchImpl?: typeof fetch;
}

export function LogViewerApp({
  vscode = getDefaultVsCodeApi<LogViewerFromWebviewMessage>(),
  messageBus = getDefaultMessageBus(),
  fetchImpl
}: LogViewerAppProps = {}) {
  const [fileName, setFileName] = useState('');
  const [locale, setLocale] = useState('en');
  const [metadata, setMetadata] = useState<Metadata | undefined>(undefined);
  const [entries, setEntries] = useState<ParsedLogEntry[]>([]);
  const [triage, setTriage] = useState<LogViewerTriagePayload | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [triageState, setTriageState] = useState<TriageState>('loading');
  const [activeDiagnosticId, setActiveDiagnosticId] = useState<number | undefined>(undefined);
  const [activeDiagnosticSeverityFilter, setActiveDiagnosticSeverityFilter] = useState<DiagnosticSeverityFilter>('all');
  const latestRequestId = useRef(0);
  const listRef = useRef<ListImperativeAPI | null>(null);
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(-1);
  const activeLogId = useRef<string>('');

  const resolvedFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage({ type: 'logViewerReady' });
      return;
    }

    const handler = (event: MessageEvent<LogViewerToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'logViewerInit') {
        const nextLogId = typeof msg.logId === 'string' ? msg.logId : '';
        activeLogId.current = nextLogId;
        setLocale(msg.locale || 'en');
        setFileName(msg.fileName);
        setMetadata(msg.metadata);
        setTriage(msg.triage);
        if (msg.triage) {
          setTriageState(getResolvedTriageState(msg.triage));
        } else {
          setTriageState('loading');
        }
        setActiveDiagnosticId(undefined);
        setActiveDiagnosticSeverityFilter('all');
        if (typeof msg.logUri === 'string' && msg.logUri.length > 0) {
          if (resolvedFetch) {
            const requestId = ++latestRequestId.current;
            setLoading(true);
            setError(undefined);
            setEntries([]);
            void resolvedFetch(msg.logUri)
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
            setEntries([]);
            setLoading(false);
            setError('Failed to load log content: Fetch API unavailable');
          }
        } else {
          const parsed = parseLogLines(Array.isArray(msg.lines) ? msg.lines : []);
          setEntries(parsed);
          setLoading(false);
          setError(undefined);
        }
      } else if (msg.type === 'logViewerError') {
        activeLogId.current = '';
        setTriage(undefined);
        setTriageState('empty');
        setActiveDiagnosticId(undefined);
        setError(msg.message);
        setLoading(false);
      } else if (msg.type === 'logViewerTriageUpdate') {
        if (msg.logId !== activeLogId.current) {
          return;
        }
        setTriage(msg.triage);
        setTriageState(msg.triage ? getResolvedTriageState(msg.triage) : 'unavailable');
      }
    };
    messageBus.addEventListener('message', handler as EventListener);
    vscode.postMessage({ type: 'logViewerReady' });
    return () => {
      messageBus.removeEventListener('message', handler as EventListener);
    };
  }, [messageBus, resolvedFetch, vscode]);

  const counts = useMemo(() => {
    let debug = 0;
    let errors = 0;
    let soql = 0;
    let dml = 0;
    for (const entry of entries) {
      switch (entry.category) {
        case 'debug':
          debug++;
          break;
        case 'error':
          errors++;
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
      errors,
      soql,
      dml
    };
  }, [entries]);

  const mappedDiagnostics = useMemo(() => mapDiagnosticsToEntries(entries, triage?.reasons ?? []), [entries, triage?.reasons]);
  const primaryReason = useMemo(() => {
    const summary = triage?.primaryReason?.trim();
    return summary ? summary : undefined;
  }, [triage?.primaryReason]);

  const mappedDiagnosticById = useMemo(() => {
    const map = new Map<number, LogViewerMappedDiagnostic>();
    for (const group of mappedDiagnostics.mappedEntries) {
      for (const diagnostic of group.diagnostics) {
        map.set(diagnostic.originalIndex, diagnostic);
      }
    }
    return map;
  }, [mappedDiagnostics.mappedEntries]);

  const orderedDiagnosticsWithMapping = useMemo(
    () => mappedDiagnostics.orderedDiagnostics.map(diagnostic => mappedDiagnosticById.get(diagnostic.originalIndex) ?? diagnostic),
    [mappedDiagnostics.orderedDiagnostics, mappedDiagnosticById]
  );

  const activeDiagnosticSummary = useMemo(() => {
    if (typeof activeDiagnosticId !== 'number') {
      return undefined;
    }
    return orderedDiagnosticsWithMapping.find(diagnostic => diagnostic.originalIndex === activeDiagnosticId);
  }, [activeDiagnosticId, orderedDiagnosticsWithMapping]);

  const shouldIncludeByFilter = useCallback(
    (entry: ParsedLogEntry) => {
      switch (filter) {
        case 'debug':
          if (entry.category !== 'debug') return false;
          break;
        case 'error':
          if (entry.category !== 'error') return false;
          break;
        case 'soql':
          if (entry.category !== 'soql') return false;
          break;
        case 'dml':
          if (entry.category !== 'dml') return false;
          break;
      }
      return true;
    },
    [filter]
  );

  const orderedDiagnostics = useMemo(
    () => orderedDiagnosticsWithMapping.filter(diagnostic => activeDiagnosticSeverityFilter === 'all' || diagnostic.severity === activeDiagnosticSeverityFilter),
    [activeDiagnosticSeverityFilter, orderedDiagnosticsWithMapping]
  );

  const visibleDiagnosticRows = useMemo(
      () =>
        buildVisibleEntries({
          entries: mappedDiagnostics.mappedEntries,
          shouldIncludeEntry: shouldIncludeByFilter,
          activeDiagnostic: activeDiagnosticSummary
        }),
    [mappedDiagnostics.mappedEntries, shouldIncludeByFilter, activeDiagnosticSummary]
  );

  const visibleEntries = useMemo(() => visibleDiagnosticRows.map(entry => entry.entry), [visibleDiagnosticRows]);

  useEffect(() => {
    if (activeDiagnosticId === undefined) {
      return;
    }
    if (activeDiagnosticSummary === undefined) {
      setActiveDiagnosticId(undefined);
      return;
    }
    if (
      activeDiagnosticSeverityFilter !== 'all' &&
      activeDiagnosticSummary.severity !== activeDiagnosticSeverityFilter
    ) {
      setActiveDiagnosticId(undefined);
    }
  }, [activeDiagnosticId, activeDiagnosticSeverityFilter, activeDiagnosticSummary]);

  const entryDiagnosticSummaries = useMemo(
    () =>
      visibleDiagnosticRows.map(({ entry, diagnostics }) => ({
        entryId: entry.id,
        diagnostics
      })),
    [visibleDiagnosticRows]
  );

  const activeDiagnosticEntryIndex = useMemo(() => {
    if (activeDiagnosticSummary?.mappedEntryId === undefined) {
      return undefined;
    }
    const index = visibleEntries.findIndex(entry => entry.id === activeDiagnosticSummary.mappedEntryId);
    if (index < 0) {
      return undefined;
    }
    return index;
  }, [activeDiagnosticSummary, visibleEntries]);

  const trimmedSearch = useMemo(() => search.trim(), [search]);

  const matchIndices = useMemo(() => {
    const needle = trimmedSearch.toLowerCase();
    if (!needle) {
      return [] as number[];
    }
    const matches: number[] = [];
    visibleEntries.forEach((entry, index) => {
      const haystack = [entry.timestamp, entry.type, entry.message, entry.details, entry.raw]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (haystack.includes(needle)) {
        matches.push(index);
      }
    });
    return matches;
  }, [visibleEntries, trimmedSearch]);

  useEffect(() => {
    setActiveMatchIndex(prev => {
      if (!trimmedSearch || matchIndices.length === 0) {
        return -1;
      }
      if (prev >= 0 && prev < matchIndices.length) {
        return prev;
      }
      return 0;
    });
  }, [matchIndices, trimmedSearch]);

  const previousSearchRef = useRef<string>(trimmedSearch);

  useEffect(() => {
    if (activeMatchIndex < 0) {
      previousSearchRef.current = trimmedSearch;
      return;
    }
    const target = matchIndices[activeMatchIndex];
    if (target === undefined) {
      previousSearchRef.current = trimmedSearch;
      return;
    }
    const previousSearch = previousSearchRef.current;
    const behavior: ScrollBehavior = previousSearch === trimmedSearch ? 'smooth' : 'auto';
    listRef.current?.scrollToRow({ index: target, align: 'center', behavior });
    previousSearchRef.current = trimmedSearch;
  }, [activeMatchIndex, matchIndices, trimmedSearch]);

  const goToNextMatch = useCallback(() => {
    if (matchIndices.length === 0) {
      return;
    }
    setActiveMatchIndex(prev => {
      if (prev < 0) {
        return 0;
      }
      return (prev + 1) % matchIndices.length;
    });
  }, [matchIndices.length]);

  const goToPreviousMatch = useCallback(() => {
    if (matchIndices.length === 0) {
      return;
    }
    setActiveMatchIndex(prev => {
      if (prev < 0) {
        return matchIndices.length - 1;
      }
      return (prev - 1 + matchIndices.length) % matchIndices.length;
    });
  }, [matchIndices.length]);

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
        matchCount={matchIndices.length}
        activeMatchIndex={activeMatchIndex}
        onNextMatch={goToNextMatch}
        onPreviousMatch={goToPreviousMatch}
      />
      <LogViewerFilters active={filter} onChange={setFilter} counts={counts} locale={locale} />
      <main className="flex min-h-0 flex-1 flex-col bg-background/40">
        <div className="grid min-h-0 flex-1 gap-3 px-4 pb-3 lg:grid-cols-[1fr_22rem]">
          <section className="min-h-0">
            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : loading ? (
              <div className="rounded-md border border-border/40 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                Loading log entries…
              </div>
              ) : (
              <LogEntryList
                entries={visibleEntries}
                entryDiagnosticSummaries={entryDiagnosticSummaries}
                highlightCategory={highlightCategory}
                matchIndices={matchIndices}
                activeMatchIndex={activeMatchIndex >= 0 ? activeMatchIndex : undefined}
                searchTerm={trimmedSearch}
                listRef={listRef}
                activeDiagnosticId={activeDiagnosticId}
                activeDiagnosticEntryIndex={activeDiagnosticEntryIndex}
              />
            )}
          </section>
          <LogDiagnosticsSidebar
            diagnostics={orderedDiagnostics}
            activeId={activeDiagnosticId}
            filter={activeDiagnosticSeverityFilter}
            onFilterChange={setActiveDiagnosticSeverityFilter}
            onSelectDiagnostic={nextActiveDiagnosticId =>
              setActiveDiagnosticId(current => (current === nextActiveDiagnosticId ? undefined : nextActiveDiagnosticId))
            }
            primaryReason={primaryReason}
            triageState={triageState}
          />
        </div>
      </main>
      <LogViewerStatusBar counts={counts} locale={locale} metadata={metadata} />
    </div>
  );
}

export function mountLogViewerApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<LogViewerFromWebviewMessage>; messageBus?: MessageBus; fetchImpl?: typeof fetch } = {}
) {
  const root = createRoot(container);
  root.render(
    <LogViewerApp
      vscode={options.vscode ?? getDefaultVsCodeApi<LogViewerFromWebviewMessage>()}
      messageBus={options.messageBus ?? getDefaultMessageBus()}
      fetchImpl={options.fetchImpl}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('root');
  if (host) {
    mountLogViewerApp(host);
  }
}
