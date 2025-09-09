import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LogGraph, NestedFrame, LogIssue } from '../shared/apexLogParser/types';
import type { DiagramExtensionToWebviewMessage, DiagramWebviewToExtensionMessage } from '../shared/diagramMessages';
import { DiagramToolbar } from './components/diagram/DiagramToolbar';
import { DiagramSvg } from './components/diagram/DiagramSvg';
import EntityFilter from './components/diagram/EntityFilter';
import { filterAndCollapse } from './utils/diagramFilter';

declare global {
  // Provided by VS Code webview runtime
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
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

// moved to ./utils/diagramFilter

function App() {
  const [graph, setGraph] = useState<LogGraph | undefined>(undefined);
  const [hideSystem, setHideSystem] = useState(true);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [allUnitIds, setAllUnitIds] = useState<string[]>([]);
  const [showProfilingChips, setShowProfilingChips] = useState(false);
  const [showProfilingSidebar, setShowProfilingSidebar] = useState(true);
  const [hiddenActors, setHiddenActors] = useState<Set<string>>(new Set());
  const [showEntityPanel, setShowEntityPanel] = useState(false);

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
    // Restore persisted UI state
    try {
      const state = vscode.getState<{ hiddenActorIds?: string[]; hideSystem?: boolean; collapseRepeats?: boolean; showProfilingChips?: boolean; showProfilingSidebar?: boolean }>();
      if (state) {
        if (Array.isArray(state.hiddenActorIds)) setHiddenActors(new Set(state.hiddenActorIds));
        if (typeof state.hideSystem === 'boolean') setHideSystem(state.hideSystem);
        if (typeof state.collapseRepeats === 'boolean') setCollapseRepeats(state.collapseRepeats);
        if (typeof state.showProfilingChips === 'boolean') setShowProfilingChips(state.showProfilingChips);
        if (typeof state.showProfilingSidebar === 'boolean') setShowProfilingSidebar(state.showProfilingSidebar);
      }
    } catch {}
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
    () => filterAndCollapse(framesRaw, hideSystem, collapseRepeats, hiddenActors),
    [framesRaw, hideSystem, collapseRepeats, hiddenActors]
  );

  const onToggleUnit = (id: string) => {
    setCollapsedUnits(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Persist certain UI states for the panel lifetime
  useEffect(() => {
    try {
      vscode.setState({
        hiddenActorIds: Array.from(hiddenActors),
        hideSystem,
        collapseRepeats,
        showProfilingChips,
        showProfilingSidebar
      });
    } catch {}
  }, [hiddenActors, hideSystem, collapseRepeats, showProfilingChips, showProfilingSidebar]);

  const allEntities = useMemo(() => {
    const arr = (graph?.nodes || []).map(n => ({ id: n.id, label: n.label, kind: n.kind }));
    arr.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind.localeCompare(b.kind)));
    return arr;
  }, [graph]);

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
        entityPanelOpen={showEntityPanel}
        onToggleEntityPanel={setShowEntityPanel}
        hiddenCount={hiddenActors.size}
      />

      <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ position: 'relative', flex: 1, overflow: 'auto' }}>
          {showEntityPanel && (
            <div
              style={{
                position: 'absolute',
                zIndex: 2,
                top: 8,
                right: 8,
                width: 360,
                maxHeight: 380,
                overflow: 'auto',
                background: 'var(--vscode-editor-background)',
                border: '1px solid var(--vscode-editorGroup-border, rgba(148,163,184,0.25))',
                borderRadius: 8,
                boxShadow: '0 4px 18px rgba(0,0,0,0.22)'
              }}
            >
              <EntityFilter
                entities={allEntities}
                hidden={hiddenActors}
                onChangeHidden={setHiddenActors}
                onClose={() => setShowEntityPanel(false)}
              />
            </div>
          )}
          <DiagramSvg
            frames={frames}
            collapsedUnits={collapsedUnits}
            onToggleUnit={onToggleUnit}
            showProfilingChips={showProfilingChips}
          />
          {frames.length === 0 && <div style={{ padding: 8, opacity: 0.8 }}>No flow detected.</div>}
        </div>
        {showProfilingSidebar && <ProfilingSidebar frames={frames} issues={graph?.issues || []} />}
      </div>
    </div>
  );
}

function ProfilingSidebar({
  frames,
  issues
}: {
  frames: (NestedFrame & { count?: number })[];
  issues: LogIssue[];
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
      {
        kind: 'Trigger' | 'Flow' | 'Class' | 'Other';
        name: string;
        soql: number;
        dml: number;
        callout: number;
        timeMs: number;
        soqlTimeMs: number;
        dmlTimeMs: number;
        calloutTimeMs: number;
      }
    >();
    for (const fr of frames) {
      // Aggregate only unit frames to avoid double counting (methods share the same actor id)
      if (fr.kind !== 'unit') continue;
      const p = fr.profile || {};
      const has = (p.timeMs || 0) + (p.soql || 0) + (p.dml || 0) + (p.callout || 0);
      if (!has) continue; // no timing or counters
      const kind = kindFromActor(fr.actor);
      const name = fr.actor.split(':').slice(1).join(':') || fr.actor;
      const cur =
        map.get(fr.actor) ||
        { kind, name, soql: 0, dml: 0, callout: 0, timeMs: 0, soqlTimeMs: 0, dmlTimeMs: 0, calloutTimeMs: 0 };
      cur.soql += p.soql || 0;
      cur.dml += p.dml || 0;
      cur.callout += p.callout || 0;
      cur.timeMs += p.timeMs || 0;
      cur.soqlTimeMs += p.soqlTimeMs || 0;
      cur.dmlTimeMs += p.dmlTimeMs || 0;
      cur.calloutTimeMs += p.calloutTimeMs || 0;
      map.set(fr.actor, cur);
    }
    const arr = Array.from(map.entries()).map(([actor, v]) => ({ actor, ...v }));
    arr.sort((a, b) => (b.timeMs - a.timeMs) || (b.soql + b.dml + b.callout - (a.soql + a.dml + a.callout)) || a.name.localeCompare(b.name));
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
            {it.timeMs ? `Time ${it.timeMs}ms` : ''}
            {it.timeMs && (it.soql || it.dml || it.callout) ? ' • ' : ''}
            {it.soql ? `S${it.soql}${it.soqlTimeMs ? `(${it.soqlTimeMs}ms)` : ''}` : ''}
            {it.soql && (it.dml || it.callout) ? ' ' : ''}
            {it.dml ? `D${it.dml}${it.dmlTimeMs ? `(${it.dmlTimeMs}ms)` : ''}` : ''}
            {it.dml && it.callout ? ' ' : ''}
            {it.callout ? `C${it.callout}${it.calloutTimeMs ? `(${it.calloutTimeMs}ms)` : ''}` : ''}
          </span>
        </div>
      ))}

      <h3 style={{ marginTop: 12 }}>Log Issues</h3>
      {issues.length === 0 && <div className="item" style={{ opacity: 0.7 }}>No issues detected.</div>}
      {issues.map((it, idx) => (
        <div key={`${it.code}-${idx}`} className="item">
          <span className="title">{it.message}</span>
          <span className="meta">
            {it.severity.toUpperCase()} • {it.code}
            {typeof it.line === 'number' ? ` • line ${it.line}` : ''}
            {it.details ? ` — ${it.details}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
