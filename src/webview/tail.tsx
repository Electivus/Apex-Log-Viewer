import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getMessages } from './i18n';
import type { OrgItem } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { TailToolbar } from './components/tail/TailToolbar';
import { TailList } from './components/tail/TailList';
import { LoadingOverlay } from './components/LoadingOverlay';

declare global {
  var acquireVsCodeApi: <T = unknown>() => { postMessage: (msg: T) => void };
}

const vscode = acquireVsCodeApi<WebviewToExtensionMessage>();

type TailMessage = ExtensionToWebviewMessage;

function App() {
  const TAIL_MAX_LINES = 10000; // keep a rolling buffer to avoid memory bloat
  const [locale, setLocale] = useState('en');
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [colorize, setColorize] = useState(false);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [debugLevel, setDebugLevel] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const t = getMessages(locale) as any;
  const listRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as TailMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'init') {
        setLocale(msg.locale);
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
          const drop = Math.max(0, merged.length - TAIL_MAX_LINES);
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
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'getOrgs' });
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!autoScroll) {
      return;
    }
    const el = listRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const scrollToIndex = useCallback((idx: number, behavior: ScrollBehavior = 'auto') => {
    const container = listRef.current;
    const el = lineRefs.current.get(idx);
    if (container && el) {
      try {
        el.scrollIntoView({ block: 'center', behavior });
      } catch {
        const top = el.offsetTop - container.clientHeight / 2;
        container.scrollTop = Math.max(0, top);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedIndex === undefined) {
      return;
    }
    scrollToIndex(selectedIndex, 'auto');
  }, [selectedIndex, query, lines.length, scrollToIndex]);

  const filteredIndexes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return lines.map((_, idx) => idx);
    }
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.toLowerCase().includes(q)) {
        out.push(i);
      }
    }
    return out;
  }, [lines, query]);

  const start = () => {
    setError(undefined);
    if (!debugLevel) {
      setError('Select a debug level');
      return;
    }
    vscode.postMessage({ type: 'tailStart', debugLevel });
  };
  const stop = () => vscode.postMessage({ type: 'tailStop' });
  const clear = () => vscode.postMessage({ type: 'tailClear' });

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
            vscode.postMessage({ type: 'openLog', logId: selectedLogId });
          }
        }}
        onReplaySelected={() => {
          if (selectedLogId) {
            vscode.postMessage({ type: 'replay', logId: selectedLogId });
          }
        }}
        actionsEnabled={!!selectedLogId}
        orgs={orgs}
        selectedOrg={selectedOrg}
        onSelectOrg={value => {
          setSelectedOrg(value);
          vscode.postMessage({ type: 'selectOrg', target: value });
        }}
        query={query}
        onQueryChange={setQuery}
        colorize={colorize}
        onToggleColorize={setColorize}
        debugLevels={debugLevels}
        debugLevel={debugLevel}
        onDebugLevelChange={setDebugLevel}
        autoScroll={autoScroll}
        onToggleAutoScroll={setAutoScroll}
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
          scrollToIndex(idx, 'smooth');
        }}
        colorize={colorize}
        running={running}
        listRef={listRef}
        registerLineRef={(idx, el) => {
          if (el) {
            lineRefs.current.set(idx, el);
          } else {
            lineRefs.current.delete(idx);
          }
        }}
      />
    </div>
  );
}

const container = document.getElementById('root')!;
createRoot(container).render(<App />);
