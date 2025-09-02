import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LogGraph, NestedFrame } from '../shared/apexLogParser';
import type { DiagramExtensionToWebviewMessage, DiagramWebviewToExtensionMessage } from '../shared/diagramMessages';
import { DiagramToolbar } from './components/diagram/DiagramToolbar';
import { DiagramSvg } from './components/diagram/DiagramSvg';

declare global {
  // Provided by VS Code webview runtime
  var acquireVsCodeApi: <T = unknown>() => { postMessage: (msg: T) => void };
}

const vscode = acquireVsCodeApi<DiagramWebviewToExtensionMessage>();

function unitId(fr: NestedFrame): string {
  return `${fr.actor}:${fr.start}`;
}

function shallowEqualArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function filterAndCollapse(
  frames: NestedFrame[] | undefined,
  hideSystem: boolean,
  collapseRepeats: boolean
): (NestedFrame & { count?: number })[] {
  let list: NestedFrame[] = (frames || []).slice();
  if (hideSystem) {
    list = list.filter(fr => !/^Class:System\b/.test(fr.actor) && !/^System\./.test(fr.label));
  }
  // Collapse consecutive repeats on same lane, same depth and same label
  list.sort((a, b) => a.start - b.start || a.depth - b.depth);
  if (!collapseRepeats) return list as any;
  const out: (NestedFrame & { count?: number })[] = [];
  for (const f of list) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.actor === f.actor &&
      prev.depth === f.depth &&
      prev.label === f.label &&
      (prev.end ?? prev.start) <= f.start
    ) {
      prev.end = f.end ?? f.start + 1;
      prev.count = (prev.count || 1) + 1;
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

function App() {
  const [graph, setGraph] = useState<LogGraph | undefined>(undefined);
  const [hideSystem, setHideSystem] = useState(true);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [allUnitIds, setAllUnitIds] = useState<string[]>([]);

  // Listen for graph messages and announce readiness
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data as DiagramExtensionToWebviewMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'graph') {
        setGraph(msg.graph);
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Memoize to avoid a new empty array each render (prevents effect loops)
  const framesRaw = useMemo(() => graph?.nested ?? [], [graph]);

  // Keep collapsed state across updates, pruning ids that no longer exist
  useEffect(() => {
    const ids = framesRaw.filter(f => f.kind === 'unit').map(unitId);

    // Only update if list actually changed
    setAllUnitIds(prev => (shallowEqualArray(prev, ids) ? prev : ids));

    // Prune collapsed set to existing ids only; avoid updates when identical
    setCollapsedUnits(prev => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of ids) if (prev.has(id)) next.add(id);
      return setsEqual(prev, next) ? prev : next;
    });
  }, [framesRaw]);

  const frames = useMemo(
    () => filterAndCollapse(framesRaw, hideSystem, collapseRepeats),
    [framesRaw, hideSystem, collapseRepeats]
  );

  const onToggleUnit = (id: string) => {
    setCollapsedUnits(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Scoped styles for the diagram webview */}
      <style>
        {`
          html, body, #root { height: 100%; }
          body { margin: 0; }
          #root { position: relative; }
          .toolbar { display: flex; align-items: center; gap: 12px; padding: 6px 10px; position: relative; }
          .legend { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; opacity: 0.9; font-size: 12px; }
          .legend .item { display: inline-flex; align-items: center; gap: 4px; }
          .legend .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
        `}
      </style>

      <DiagramToolbar
        hideSystem={hideSystem}
        onToggleHideSystem={setHideSystem}
        collapseRepeats={collapseRepeats}
        onToggleCollapseRepeats={setCollapseRepeats}
        onExpandAll={() => setCollapsedUnits(new Set())}
        onCollapseAll={() => setCollapsedUnits(new Set(allUnitIds))}
      />

      <div style={{ position: 'relative', flex: 1, overflow: 'auto' }}>
        <DiagramSvg frames={frames} collapsedUnits={collapsedUnits} onToggleUnit={onToggleUnit} />
        {frames.length === 0 && (
          <div style={{ padding: 8, opacity: 0.8 }}>No flow detected.</div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
