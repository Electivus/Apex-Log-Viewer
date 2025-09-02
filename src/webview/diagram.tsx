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
      if (f.profile) {
        // Sum profiling counters when collapsing
        (prev.profile ||= {});
        if (f.profile.soql) prev.profile.soql = (prev.profile.soql || 0) + f.profile.soql;
        if (f.profile.dml) prev.profile.dml = (prev.profile.dml || 0) + f.profile.dml;
        if (f.profile.callout) prev.profile.callout = (prev.profile.callout || 0) + f.profile.callout;
        if (f.profile.cpuMs) prev.profile.cpuMs = (prev.profile.cpuMs || 0) + f.profile.cpuMs;
        if (f.profile.heapBytes) prev.profile.heapBytes = (prev.profile.heapBytes || 0) + f.profile.heapBytes;
      }
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
  const [showProfilingChips, setShowProfilingChips] = useState(false);
  const [showProfilingSidebar, setShowProfilingSidebar] = useState(true);

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
          .sidebar { position: relative; top: 0; right: 0; bottom: 0; overflow: auto; padding: 8px 10px; border-left: 1px solid var(--vscode-editorGroup-border, rgba(148,163,184,0.25)); }
          .sidebar h3 { margin: 6px 0 6px; font-size: 12px; font-weight: 700; opacity: 0.9; }
          .sidebar .item { margin: 8px 0; font-size: 12px; }
          .sidebar .title { font-weight: 600; display: block; }
          .sidebar .meta { opacity: 0.85; }
        `}
      </style>

      <DiagramToolbar
        hideSystem={hideSystem}
        onToggleHideSystem={setHideSystem}
        collapseRepeats={collapseRepeats}
        onToggleCollapseRepeats={setCollapseRepeats}
        onExpandAll={() => setCollapsedUnits(new Set())}
        onCollapseAll={() => setCollapsedUnits(new Set(allUnitIds))}
        showProfilingChips={showProfilingChips}
        onToggleShowProfilingChips={setShowProfilingChips}
        showProfilingSidebar={showProfilingSidebar}
        onToggleShowProfilingSidebar={setShowProfilingSidebar}
      />

      <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ position: 'relative', flex: 1, overflow: 'auto' }}>
          <DiagramSvg
            frames={frames}
            collapsedUnits={collapsedUnits}
            onToggleUnit={onToggleUnit}
            showProfilingChips={showProfilingChips}
          />
          {frames.length === 0 && <div style={{ padding: 8, opacity: 0.8 }}>No flow detected.</div>}
        </div>
        {showProfilingSidebar && <ProfilingSidebar frames={frames} />}
      </div>
    </div>
  );
}

function ProfilingSidebar({
  frames
}: {
  frames: (NestedFrame & { count?: number })[];
}) {
  function kindFromActor(actor: string): 'Trigger' | 'Flow' | 'Class' | 'Other' {
    if (actor.startsWith('Trigger:')) return 'Trigger';
    if (actor.startsWith('Flow:')) return 'Flow';
    if (actor.startsWith('Class:')) return 'Class';
    return 'Other';
  }
  function humanBytes(n?: number): string {
    if (!n || n <= 0) return '0 B';
    const kb = n / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  }
  const agg = useMemo(() => {
    const map = new Map<
      string,
      { kind: 'Trigger' | 'Flow' | 'Class' | 'Other'; name: string; soql: number; dml: number; callout: number; cpuMs: number; heapBytes: number }
    >();
    for (const fr of frames) {
      // Aggregate only unit frames to avoid double counting (methods share the same actor id)
      if (fr.kind !== 'unit') continue;
      const p = fr.profile;
      if (!p) continue;
      const has = (p.soql || 0) + (p.dml || 0) + (p.callout || 0) + (p.cpuMs || 0) + (p.heapBytes || 0);
      if (!has) continue;
      const kind = kindFromActor(fr.actor);
      const name = fr.actor.split(':').slice(1).join(':') || fr.actor;
      const cur = map.get(fr.actor) || { kind, name, soql: 0, dml: 0, callout: 0, cpuMs: 0, heapBytes: 0 };
      cur.soql += p.soql || 0;
      cur.dml += p.dml || 0;
      cur.callout += p.callout || 0;
      cur.cpuMs += p.cpuMs || 0;
      cur.heapBytes += p.heapBytes || 0;
      map.set(fr.actor, cur);
    }
    const arr = Array.from(map.entries()).map(([actor, v]) => ({ actor, ...v }));
    arr.sort((a, b) => (b.cpuMs - a.cpuMs) || (b.soql + b.dml + b.callout - (a.soql + a.dml + a.callout)) || a.name.localeCompare(b.name));
    return arr;
  }, [frames]);

  return (
    <div className="sidebar" style={{ width: 300 }}>
      <h3>Profiling</h3>
      {agg.length === 0 && <div className="item" style={{ opacity: 0.7 }}>No profiling data.</div>}
      {agg.map(it => (
        <div key={it.actor} className="item">
          <span className="title">{it.name}</span>
          <span className="meta">
            {it.cpuMs ? `CPU ${it.cpuMs}ms` : ''}
            {it.cpuMs && (it.heapBytes || it.soql || it.dml || it.callout) ? ' • ' : ''}
            {it.heapBytes ? `Heap ${humanBytes(it.heapBytes)}` : ''}
            {(it.heapBytes && (it.soql || it.dml || it.callout)) ? ' • ' : ''}
            {it.soql ? `S${it.soql}` : ''}
            {it.soql && (it.dml || it.callout) ? ' ' : ''}
            {it.dml ? `D${it.dml}` : ''}
            {it.dml && it.callout ? ' ' : ''}
            {it.callout ? `C${it.callout}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
