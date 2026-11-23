import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';
import { createRoot } from 'react-dom/client';
import { getMessages } from './i18n';
import { decodeLogLine } from '@alv/protocol/logText';
import type { OrgItem } from '@alv/protocol/types';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage
} from '@alv/protocol/messages';
import { TailToolbar } from './components/tail/TailToolbar';
import { TailList } from './components/tail/TailList';
import { LoadingOverlay } from './components/LoadingOverlay';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

type TailMessage = ExtensionToWebviewMessage;

interface TailUiState {
  query: string;
  onlyUserDebug: boolean;
  autoScroll: boolean;
  colorize: boolean;
  debugLevelByOrg: Record<string, string>;
  /** The selected line by its log's header line, which names the log, how far below it it is, and its text. */
  selected?: SelectedLine;
}

interface SelectedLine {
  header: string;
  offset: number;
  text: string;
}

const isHeader = (line: string) => line.startsWith('=== ApexLog ');

function buildReadyMessage(): WebviewToExtensionMessage {
  const content = document.querySelector('meta[name="alv-mount-sequence"]')?.getAttribute('content');
  const mountSequence = content ? Number.parseInt(content, 10) : Number.NaN;
  return Number.isInteger(mountSequence) && mountSequence >= 0 ? { type: 'ready', mountSequence } : { type: 'ready' };
}

function readInitialUiState(vscode: VsCodeWebviewApi<WebviewToExtensionMessage>): TailUiState {
  const raw = vscode.getState<Partial<TailUiState>>() ?? {};
  return {
    query: typeof raw.query === 'string' ? raw.query : '',
    onlyUserDebug: raw.onlyUserDebug === true,
    autoScroll: raw.autoScroll !== false,
    colorize: raw.colorize === true,
    debugLevelByOrg: typeof raw.debugLevelByOrg === 'object' && raw.debugLevelByOrg !== null ? raw.debugLevelByOrg : {},
    selected:
      typeof raw.selected?.header === 'string' && typeof raw.selected.text === 'string' &&
      Number.isInteger(raw.selected.offset) && raw.selected.offset >= 0
        ? raw.selected
        : undefined
  };
}

/**
 * The lines the panel holds and the sequence number of the first one. Sequence numbers count every line received
 * since the panel opened, so a line keeps its number while older lines leave the buffer and after a clear.
 */
interface TailBuffer {
  lines: string[];
  firstSeq: number;
}

/** Lines kept while Auto-scroll is off, so older lines stay and the lines in view do not move; bounds the memory. */
const pausedBufferLines = (limit: number) => Math.min(400_000, Math.max(2 * limit, limit + 20_000));

/** Drops lines from the head until at most `max` remain. */
function trimBuffer(buffer: TailBuffer, max: number): TailBuffer {
  const drop = Math.max(0, buffer.lines.length - max);
  return drop > 0 ? { lines: buffer.lines.slice(drop), firstSeq: buffer.firstSeq + drop } : buffer;
}

export interface TailAppProps {
  vscode?: VsCodeWebviewApi<WebviewToExtensionMessage>;
  messageBus?: MessageBus;
}

export function TailApp({
  vscode = getDefaultVsCodeApi<WebviewToExtensionMessage>(),
  messageBus = getDefaultMessageBus()
}: TailAppProps = {}) {
  const [initialUiState] = useState<TailUiState>(() => readInitialUiState(vscode));
  const initialUiStateRef = useRef<TailUiState>(initialUiState);
  const [locale, setLocale] = useState('en');
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [buffer, setBuffer] = useState<TailBuffer>({ lines: [], firstSeq: 0 });
  const lines = buffer.lines;
  const bufferRef = useRef(buffer); // also set by messages, for one handled before the next render
  bufferRef.current = buffer;
  const [tailMaxLines, setTailMaxLines] = useState(10000);
  const tailMaxLinesRef = useRef(10000);
  const [query, setQuery] = useState(initialUiStateRef.current.query);
  const [onlyUserDebug, setOnlyUserDebug] = useState(initialUiStateRef.current.onlyUserDebug);
  const [autoScroll, setAutoScroll] = useState(initialUiStateRef.current.autoScroll);
  const autoScrollPausedByScrollRef = useRef(false);
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const [colorize, setColorize] = useState(initialUiStateRef.current.colorize);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [activeDebugLevel, setActiveDebugLevel] = useState<string | undefined>(undefined);
  const [debugLevelByOrg, setDebugLevelByOrg] = useState(initialUiStateRef.current.debugLevelByOrg);
  const [error, setError] = useState<string | undefined>(undefined);
  // The selected line by its sequence number, so that it stays the same line while lines leave or arrive.
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>(undefined);
  const selectedIndex =
    selectedSeq !== undefined && selectedSeq >= buffer.firstSeq && selectedSeq < buffer.firstSeq + lines.length
      ? selectedSeq - buffer.firstSeq
      : undefined;
  let header = selectedIndex ?? -1;
  while (header >= 0 && !isHeader(lines[header]!)) header--;
  const selectedLine: SelectedLine | undefined =
    header < 0 ? undefined : { header: lines[header]!, offset: selectedIndex! - header, text: lines[selectedIndex!]! };
  const replayRef = useRef(initialUiStateRef.current.selected);
  const selectedLineRef = useRef(selectedLine);
  selectedLineRef.current = selectedLine;
  const [loading, setLoading] = useState(false);
  const t = getMessages(locale) as any;
  const listRef = useRef<ListImperativeAPI | null>(null);

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage(buildReadyMessage());
      return;
    }
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
        tailMaxLinesRef.current = clamped;
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
        setActiveDebugLevel(msg.active);
      }
      if (msg.type === 'tailStatus') {
        setRunning(!!msg.running);
      }
      if (msg.type === 'tailData') {
        const incoming = Array.isArray(msg.lines) ? msg.lines : [];
        const replay = replayRef.current;
        replayRef.current = undefined;
        if (replay && bufferRef.current.lines.length === 0) {
          // The same line of the same log, with no other log between them, or none.
          const head = incoming.indexOf(replay.header);
          const index = head + replay.offset;
          const inLog = head >= 0 && !incoming.slice(head + 1, index + 1).some(isHeader);
          setSelectedSeq(inLog && incoming[index] === replay.text ? bufferRef.current.firstSeq + index : undefined);
        }
        const max = autoScrollRef.current ? tailMaxLinesRef.current : pausedBufferLines(tailMaxLinesRef.current);
        bufferRef.current = trimBuffer({ ...bufferRef.current, lines: bufferRef.current.lines.concat(incoming) }, max);
        setBuffer(bufferRef.current);
      }
      if (msg.type === 'tailReset') {
        replayRef.current = selectedLineRef.current ?? replayRef.current;
        const reset = { lines: [], firstSeq: bufferRef.current.firstSeq + bufferRef.current.lines.length };
        bufferRef.current = reset;
        setBuffer(reset);
      }
      if (msg.type === 'error') {
        setError(msg.message);
      }
    };
    messageBus.addEventListener('message', handler as EventListener);
    vscode.postMessage(buildReadyMessage());
    return () => messageBus.removeEventListener('message', handler as EventListener);
  }, [messageBus, vscode]);

  const savedSelection = selectedLine ?? (autoScroll ? undefined : replayRef.current); // one still to find stays saved
  useEffect(() => {
    vscode.setState({
      query,
      onlyUserDebug,
      autoScroll,
      colorize,
      debugLevelByOrg,
      selected: savedSelection
    } satisfies TailUiState);
  }, [autoScroll, colorize, debugLevelByOrg, onlyUserDebug, query, JSON.stringify(savedSelection), vscode]);

  // Back to the limit when it changes, or at once when Auto-scroll turns on again.
  useLayoutEffect(() => {
    tailMaxLinesRef.current = tailMaxLines;
    if (autoScroll) replayRef.current = undefined;
    setBuffer(prev => trimBuffer(prev, autoScroll ? tailMaxLines : pausedBufferLines(tailMaxLines)));
  }, [tailMaxLines, autoScroll]);

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

  // To the selected line when it or the search changes, never because lines arrived.
  useEffect(() => {
    if (selectedIndex === undefined) {
      return;
    }
    scrollToIndex(selectedIndex, 'auto');
  }, [selectedSeq, query, onlyUserDebug]);

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
  const clear = () => {
    setSelectedSeq(undefined);
    vscode.postMessage({ type: 'tailClear' });
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
            setSelectedSeq(undefined);
          }
        }}
        error={error}
        t={t}
      />
      <TailList
        lines={lines}
        filteredIndexes={filteredIndexes}
        firstLineSeq={buffer.firstSeq}
        selectedIndex={selectedIndex}
        onSelectIndex={idx => {
          setSelectedSeq(buffer.firstSeq + idx);
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
