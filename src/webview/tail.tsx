import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';
import { createRoot } from 'react-dom/client';
import { getMessages } from './i18n';
import type { OrgItem } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { TailToolbar } from './components/tail/TailToolbar';
import { TailList } from './components/tail/TailList';
import { LoadingOverlay } from './components/LoadingOverlay';

declare global {
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}

const vscode = acquireVsCodeApi<WebviewToExtensionMessage>();

type TailMessage = ExtensionToWebviewMessage;

function App() {
  const [locale, setLocale] = useState('en');
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [tailMaxLines, setTailMaxLines] = useState(10000);
  const [query, setQuery] = useState('');
  const [onlyUserDebug, setOnlyUserDebug] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollPausedByScrollRef = useRef(false);
  const [colorize, setColorize] = useState(false);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [debugLevel, setDebugLevel] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const t = getMessages(locale) as any;
  const listRef = useRef<ListImperativeAPI | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as TailMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'init') {
        setLocale(msg.locale);
      }
      if (msg.type === 'tailConfig') {
        const n = typeof (msg as any).tailBufferSize === 'number' ? Math.floor((msg as any).tailBufferSize) : 10000;
        const clamped = Math.max(1000, Math.min(200000, n));
        setTailMaxLines(clamped);
      }
      if (msg.type === 'loading') {
        setLoading(!!msg.value);
      }
      if (msg.type === 'orgs') {
        setOrgs(msg.data || []);
        setSelectedOrg(msg.selected);
      }
      if (msg.type === 'debugLevels') {
        setDebugLevels(msg.data || []);
        if (typeof msg.active === 'string') {
          setDebugLevel(msg.active);
        } else if (msg.data && msg.data.length > 0) {
          setDebugLevel(prev => prev || msg.data![0]!);
        }
      }
      if (msg.type === 'tailStatus') {
        setRunning(!!msg.running);
      }
      if (msg.type === 'tailData') {
        const incoming = Array.isArray(msg.lines) ? msg.lines : [];
        setLines(prev => {
          const merged = prev.length ? prev.concat(incoming) : [...incoming];
          const drop = Math.max(0, merged.length - tailMaxLines);
          if (drop > 0) {
            // Adjust selection to account for trimmed prefix
            setSelectedIndex(idx => (idx === undefined ? undefined : idx - drop >= 0 ? idx - drop : undefined));
            return merged.slice(drop);
          }
          return merged;
        });
      }
      if (msg.type === 'tailReset') {
        setLines([]);
      }
      if (msg.type === 'error') {
        setError(msg.message);
      }
    };
    window.addEventListener('message', handler);
    const ready = { type: 'ready' } as const satisfies WebviewToExtensionMessage;
    vscode.postMessage(ready);
    const getOrgs = { type: 'getOrgs' } as const satisfies WebviewToExtensionMessage;
    vscode.postMessage(getOrgs);
    return () => window.removeEventListener('message', handler);
  }, []);

  const filteredIndexes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || '';
      const upper = l.toUpperCase();
      const isHeader = upper.startsWith('=== APEXLOG ');
      // Heuristic for USER_DEBUG according to Apex log format
      const isUserDebug =
        !isHeader && (upper.includes('|USER_DEBUG|') || (upper.includes('|DEBUG|') && upper.includes('USER_DEBUG')));
      if (onlyUserDebug && !isUserDebug) {
        continue;
      }
      if (q && !l.toLowerCase().includes(q)) {
        continue;
      }
      out.push(i);
    }
    return out;
  }, [lines, query, onlyUserDebug]);

  // Auto-scroll to the last visible (filtered) item when enabled
  useEffect(() => {
    if (!autoScroll) return;
    if (filteredIndexes.length === 0) return;
    const last = filteredIndexes.length - 1;
    listRef.current?.scrollToRow({ index: last, align: 'end', behavior: 'auto' });
  }, [lines, autoScroll, filteredIndexes.length]);

  // Map full indices to their current position inside filteredIndexes for O(1) lookup
  const filteredIndexMap = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < filteredIndexes.length; i++) m.set(filteredIndexes[i]!, i);
    return m;
  }, [filteredIndexes]);

  const scrollToIndex = useCallback(
    (fullIdx: number, behavior: ScrollBehavior = 'auto') => {
      const filteredPos = filteredIndexMap.get(fullIdx);
      if (filteredPos === undefined) {
        return;
      }
      listRef.current?.scrollToRow({ index: filteredPos, align: behavior === 'smooth' ? 'center' : 'auto', behavior });
    },
    [filteredIndexMap]
  );

  useEffect(() => {
    if (selectedIndex === undefined) {
      return;
    }
    scrollToIndex(selectedIndex, 'auto');
  }, [selectedIndex, query, lines.length, scrollToIndex]);

  const start = () => {
    setError(undefined);
    if (!debugLevel) {
      setError(t.tail?.selectDebugLevel ?? 'Select a debug level');
      return;
    }
    const msg = { type: 'tailStart', debugLevel } as const satisfies WebviewToExtensionMessage;
    vscode.postMessage(msg);
  };
  const stop = () => {
    const msg = { type: 'tailStop' } as const satisfies WebviewToExtensionMessage;
    vscode.postMessage(msg);
  };
  const clear = () => {
    const msg = { type: 'tailClear' } as const satisfies WebviewToExtensionMessage;
    vscode.postMessage(msg);
  };

  // Infer selected logId by scanning up to nearest header line
  const selectedLogId: string | undefined = useMemo(() => {
    if (selectedIndex === undefined) {
      return undefined;
    }
    for (let i = Math.min(selectedIndex, lines.length - 1); i >= 0; i--) {
      const L = lines[i] || '';
      if (L.startsWith('=== ApexLog ')) {
        // format: "=== ApexLog <id> | ..."
        const rest = L.substring('=== ApexLog '.length);
        const id = rest.split('|')[0]?.trim();
        return id || undefined;
      }
    }
    return undefined;
  }, [selectedIndex, lines]);

  return (
    <div
      style={{
        padding: 8,
        fontFamily: 'var(--vscode-font-family)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        position: 'relative'
      }}
    >
      <LoadingOverlay show={loading} label={t.loading} />
      <TailToolbar
        running={running}
        onStart={start}
        onStop={stop}
        onClear={clear}
        disabled={loading}
        onOpenSelected={() => {
          if (selectedLogId) {
            const msg = { type: 'openLog', logId: selectedLogId } as const satisfies WebviewToExtensionMessage;
            vscode.postMessage(msg);
          }
        }}
        onReplaySelected={() => {
          if (selectedLogId) {
            const msg = { type: 'replay', logId: selectedLogId } as const satisfies WebviewToExtensionMessage;
            vscode.postMessage(msg);
          }
        }}
        actionsEnabled={!!selectedLogId}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={value => {
          setSelectedOrg(value);
          const msg = { type: 'selectOrg', target: value } as const satisfies WebviewToExtensionMessage;
          vscode.postMessage(msg);
        }}
        query={query}
        onQueryChange={setQuery}
        onlyUserDebug={onlyUserDebug}
        onToggleOnlyUserDebug={setOnlyUserDebug}
        colorize={colorize}
        onToggleColorize={setColorize}
        debugLevels={debugLevels}
        debugLevel={debugLevel}
        onDebugLevelChange={setDebugLevel}
        autoScroll={autoScroll}
        onToggleAutoScroll={v => {
          setAutoScroll(v);
          autoScrollPausedByScrollRef.current = false; // user action overrides pause reason
          if (v) {
            // Clear selection to allow auto-scroll to take over and jump to end immediately
            setSelectedIndex(undefined);
            const last = filteredIndexes.length > 0 ? filteredIndexes.length - 1 : 0;
            listRef.current?.scrollToRow({ index: last, align: 'end', behavior: 'auto' });
          }
        }}
        error={error}
        t={t}
      />
      <TailList
        lines={lines}
        filteredIndexes={filteredIndexes}
        selectedIndex={selectedIndex}
        onSelectIndex={idx => {
          setSelectedIndex(idx);
          setAutoScroll(false);
          autoScrollPausedByScrollRef.current = false; // selection is explicit user pause
          scrollToIndex(idx, 'smooth');
        }}
        colorize={colorize}
        running={running}
        listRef={listRef}
        t={t}
        onAtBottomChange={atBottom => {
          // Only auto-toggle when current state stems from scroll pause
          if (!atBottom && autoScroll) {
            // User scrolled up -> pause
            setAutoScroll(false);
            autoScrollPausedByScrollRef.current = true;
          } else if (atBottom && !autoScroll && autoScrollPausedByScrollRef.current) {
            // User returned to bottom -> resume
            setAutoScroll(true);
            autoScrollPausedByScrollRef.current = false;
          }
        }}
      />
    </div>
  );
}

const container = document.getElementById('root')!;
createRoot(container).render(<App />);
