import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';
import { createRoot } from 'react-dom/client';
import { getMessages } from './i18n';
import { decodeLogLine } from '@alv/protocol/logText';
import type { OrgItem } from '@alv/protocol/types';
import type { ExtensionToWebviewMessage, TailLineBatch, WebviewToExtensionMessage } from '@alv/protocol/messages';
import { TailToolbar } from './components/tail/TailToolbar';
import { TailList } from './components/tail/TailList';
import { LoadingOverlay } from './components/LoadingOverlay';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

type TailSelection = { streamId: string; seq: number };

interface TailUiState {
  query: string;
  onlyUserDebug: boolean;
  autoScroll: boolean;
  colorize: boolean;
  debugLevelByOrg: Record<string, string>;
  selection?: TailSelection;
}

function buildReadyMessage(): WebviewToExtensionMessage {
  const content = document.querySelector('meta[name="alv-mount-sequence"]')?.getAttribute('content');
  const mountSequence = content ? Number.parseInt(content, 10) : Number.NaN;
  return Number.isInteger(mountSequence) && mountSequence >= 0 ? { type: 'ready', mountSequence } : { type: 'ready' };
}

function readInitialUiState(vscode: VsCodeWebviewApi<WebviewToExtensionMessage>): TailUiState {
  const raw = vscode.getState<Partial<TailUiState>>() ?? {};
  const selection = raw.selection;
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    onlyUserDebug: raw.onlyUserDebug === true,
    autoScroll: raw.autoScroll !== false,
    colorize: raw.colorize === true,
    debugLevelByOrg: typeof raw.debugLevelByOrg === 'object' && raw.debugLevelByOrg !== null ? raw.debugLevelByOrg : {},
    selection:
      typeof selection?.streamId === 'string' && Number.isSafeInteger(selection.seq) && selection.seq >= 0
        ? { streamId: selection.streamId, seq: selection.seq }
        : undefined
  };
}

interface TailContent {
  buffer?: TailLineBatch;
  selection?: TailSelection;
  snapshotFirstSeq: number;
  maxLines: number;
}

type TailLinesMessage = Extract<ExtensionToWebviewMessage, { type: 'tailData' | 'tailSnapshot' }>;

const EMPTY_LINES: string[] = [];

function selectionIndex(buffer: TailLineBatch | undefined, selection: TailSelection | undefined): number | undefined {
  if (!buffer || !selection || buffer.streamId !== selection.streamId) {
    return undefined;
  }
  const index = selection.seq - buffer.firstSeq;
  return index >= 0 && index < buffer.lines.length ? index : undefined;
}

function nextSeq(batch: TailLineBatch): number {
  return batch.firstSeq + batch.lines.length;
}

function updateBuffer(state: TailContent, batch: TailLineBatch, source: 'snapshot' | 'partial'): TailContent {
  const end = nextSeq(batch);
  const snapshotFirstSeq = source === 'snapshot' ? batch.firstSeq : state.snapshotFirstSeq;
  const retainedFrom = Math.max(snapshotFirstSeq, end - state.maxLines);
  const drop = Math.max(0, retainedFrom - batch.firstSeq);
  const buffer = drop > 0 ? { ...batch, lines: batch.lines.slice(drop), firstSeq: retainedFrom } : batch;
  const selection = state.selection;
  const canStillBeRetained =
    selection &&
    selection.streamId === batch.streamId &&
    selection.seq >= retainedFrom &&
    (source === 'partial' || selection.seq < end);
  return { ...state, buffer, snapshotFirstSeq, selection: canStillBeRetained ? selection : undefined };
}

function receiveLines(state: TailContent, { type, streamId, firstSeq, lines }: TailLinesMessage): TailContent {
  const current = state.buffer;
  if (current && current.streamId !== streamId) {
    return state;
  }
  const end = current ? nextSeq(current) : 0;
  const batch = { streamId, firstSeq, lines };
  if (type === 'tailSnapshot') {
    if (firstSeq < state.snapshotFirstSeq || nextSeq(batch) < end) {
      return state;
    }
    return updateBuffer(state, batch, 'snapshot');
  }
  if (lines.length === 0 || firstSeq < end) {
    return state;
  }
  const suffix = current && firstSeq === end ? { ...current, lines: current.lines.concat(lines) } : batch;
  return updateBuffer(state, suffix, 'partial');
}

export interface TailAppProps {
  vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>;
  messageBus?: MessageBus;
}

export function TailApp({
  vscode = getDefaultVsCodeApi<WebviewToExtensionMessage>(),
  messageBus = getDefaultMessageBus()
}: TailAppProps = {}) {
  const [initialUiState] = useState(() => readInitialUiState(vscode));
  const [locale, setLocale] = useState('en');
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState<TailContent>({
    maxLines: 10000,
    snapshotFirstSeq: 0,
    selection: initialUiState.selection
  });
  const { buffer, selection } = tail;
  const lines = buffer?.lines ?? EMPTY_LINES;
  const selectedIndex = selectionIndex(buffer, selection);
  const [query, setQuery] = useState(initialUiState.query);
  const [onlyUserDebug, setOnlyUserDebug] = useState(initialUiState.onlyUserDebug);
  const [autoScroll, setAutoScroll] = useState(initialUiState.autoScroll);
  const autoScrollPausedByScrollRef = useRef(false);
  const [colorize, setColorize] = useState(initialUiState.colorize);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [activeDebugLevel, setActiveDebugLevel] = useState<string | undefined>(undefined);
  const [debugLevelByOrg, setDebugLevelByOrg] = useState(initialUiState.debugLevelByOrg);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const t = getMessages(locale) as any;
  const listRef = useRef<ListImperativeAPI | null>(null);

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage(buildReadyMessage());
      return;
    }
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'init') {
        setLocale(msg.locale);
      }
      if (msg.type === 'tailConfig') {
        const n = Number.isFinite(msg.tailBufferSize) ? Math.floor(msg.tailBufferSize) : 10000;
        const maxLines = Math.max(1000, Math.min(200000, n));
        setTail(prev => {
          if (prev.maxLines === maxLines) {
            return prev;
          }
          const next = { ...prev, maxLines };
          return prev.buffer ? updateBuffer(next, prev.buffer, 'partial') : next;
        });
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
        setActiveDebugLevel(msg.active);
      }
      if (msg.type === 'tailStatus') {
        setRunning(!!msg.running);
      }
      if (msg.type === 'tailData' || msg.type === 'tailSnapshot') {
        setTail(prev => receiveLines(prev, msg));
      }
      if (msg.type === 'error') {
        setError(msg.message);
      }
    };
    messageBus.addEventListener('message', handler as EventListener);
    vscode.postMessage(buildReadyMessage());
    return () => messageBus.removeEventListener('message', handler as EventListener);
  }, [messageBus, vscode]);

  useEffect(() => {
    vscode.setState({
      query,
      onlyUserDebug,
      autoScroll,
      colorize,
      debugLevelByOrg,
      selection
    } satisfies TailUiState);
  }, [autoScroll, colorize, debugLevelByOrg, onlyUserDebug, query, selection, vscode]);

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
      if (q && !l.toLowerCase().includes(q) && !decodeLogLine(l).toLowerCase().includes(q)) {
        continue;
      }
      out.push(i);
    }
    return out;
  }, [lines, query, onlyUserDebug]);

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

  const orgKey = selectedOrg ?? '';
  const rememberedDebugLevel = debugLevelByOrg[orgKey];
  const debugLevel =
    rememberedDebugLevel && debugLevels.includes(rememberedDebugLevel)
      ? rememberedDebugLevel
      : activeDebugLevel || debugLevels[0] || '';
  const rememberDebugLevel = (level: string) => setDebugLevelByOrg(prev => ({ ...prev, [orgKey]: level }));

  const start = () => {
    setError(undefined);
    if (!debugLevel) {
      setError(t.tail?.selectDebugLevel ?? 'Select a debug level');
      return;
    }
    rememberDebugLevel(debugLevel);
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
    <div className="relative flex h-screen min-h-[120px] flex-col overflow-y-auto bg-background text-sm text-foreground">
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
        onOpenDebugFlags={() => {
          vscode.postMessage({ type: 'openDebugFlags' });
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
        onlyUserDebug={onlyUserDebug}
        onToggleOnlyUserDebug={setOnlyUserDebug}
        colorize={colorize}
        onToggleColorize={setColorize}
        debugLevels={debugLevels}
        debugLevel={debugLevel}
        onDebugLevelChange={rememberDebugLevel}
        autoScroll={autoScroll}
        onToggleAutoScroll={v => {
          setAutoScroll(v);
          autoScrollPausedByScrollRef.current = false; // user action overrides pause reason
          if (v) {
            // Clear selection so the list can follow; TailList jumps to the end when `follow` turns on
            setTail(prev => ({ ...prev, selection: undefined }));
          }
        }}
        error={error}
        t={t}
      />
      <TailList
        key={buffer?.streamId}
        lines={lines}
        filteredIndexes={filteredIndexes}
        firstLineSeq={buffer?.firstSeq ?? 0}
        selectedIndex={selectedIndex}
        onSelectIndex={idx => {
          if (!buffer) {
            return;
          }
          setTail(prev => ({ ...prev, selection: { streamId: buffer.streamId, seq: buffer.firstSeq + idx } }));
          setAutoScroll(false);
          autoScrollPausedByScrollRef.current = false; // selection is explicit user pause
          scrollToIndex(idx, 'smooth');
        }}
        colorize={colorize}
        running={running}
        listRef={listRef}
        follow={autoScroll}
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

export function mountTailApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>; messageBus?: MessageBus } = {}
) {
  const root = createRoot(container);
  root.render(
    <TailApp
      vscode={options.vscode ?? getDefaultVsCodeApi<WebviewToExtensionMessage>()}
      messageBus={options.messageBus ?? getDefaultMessageBus()}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const container = document.getElementById('root');
  if (container) {
    mountTailApp(container);
  }
}
