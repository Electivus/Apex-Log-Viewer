import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DiagramToolbar, type Kind } from './components/diagram/DiagramToolbar';
import { DiagramCanvas, type Nested } from './components/diagram/DiagramCanvas';

declare global {
  var acquireVsCodeApi: <T = unknown>() => { postMessage: (msg: T) => void };
}

type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  nested?: Nested[];
};

const vscode = acquireVsCodeApi<{ type: 'ready' }>();

function ensureStyles() {
  if (document.getElementById('apex-diagram-styles')) return;
  const style = document.createElement('style');
  style.id = 'apex-diagram-styles';
  style.textContent = `
    html, body, #root { height: 100%; }
    body { margin: 0; }
    #root { position: relative; }
  `;
  document.head.appendChild(style);
}

function kindFromActor(actor: string): Kind {
  if (actor.startsWith('Trigger:')) return 'Trigger';
  if (actor.startsWith('Flow:')) return 'Flow';
  if (actor.startsWith('Class:')) return 'Class';
  return 'Other';
}

function styleByKind(kind: Kind) {
  switch (kind) {
    case 'Trigger':
      return { stroke: '#60a5fa', fill: 'rgba(96,165,250,0.14)' };
    case 'Flow':
      return { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.14)' };
    case 'Class':
      return { stroke: '#34d399', fill: 'rgba(52,211,153,0.14)' };
    default:
      return { stroke: 'rgba(148,163,184,0.9)', fill: 'rgba(148,163,184,0.10)' };
  }
}

function unitId(fr: Nested): string {
  return `${fr.actor}:${fr.start}`;
}

function filterAndCollapse(frames: Nested[] | undefined, hideSystem: boolean, collapseRepeats: boolean): (Nested & { count?: number })[] {
  let list: Nested[] = (frames || []).slice();
  if (hideSystem) {
    list = list.filter(fr => !/^Class:System\b/.test(fr.actor) && !/^System\./.test(fr.label));
  }
  list.sort((a, b) => a.start - b.start || a.depth - b.depth);
  if (!collapseRepeats) return list as any;
  const out: (Nested & { count?: number })[] = [];
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
  const [graph, setGraph] = useState<Graph | undefined>(undefined);
  const [hideSystem, setHideSystem] = useState(true);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const collapseInitializedRef = useRef(false);

  useEffect(() => {
    ensureStyles();
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = (e.data || {}) as any;
      if (msg.type === 'graph') {
        setGraph(msg.graph || { nodes: [], sequence: [], nested: [] });
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const frames = useMemo(() => filterAndCollapse(graph?.nested || [], hideSystem, collapseRepeats), [graph?.nested, hideSystem, collapseRepeats]);

  const methodActorSet = useMemo(() => {
    const m = new Set<string>();
    for (const fr of frames) if (fr.kind === 'method') m.add(fr.actor);
    return m;
  }, [frames]);

  const allUnitIds = useMemo(() => frames.filter(f => f.kind === 'unit').map(unitId), [frames]);

  useEffect(() => {
    if (!collapseInitializedRef.current) {
      setCollapsedUnits(new Set());
      collapseInitializedRef.current = true;
    } else {
      setCollapsedUnits(prev => new Set(allUnitIds.filter(id => prev.has(id))));
    }
  }, [allUnitIds.join('|')]);

  const colorsByKind = useMemo(() => ({
    Trigger: styleByKind('Trigger'),
    Flow: styleByKind('Flow'),
    Class: styleByKind('Class'),
    Other: styleByKind('Other')
  }), []);

  return (
    <div id="diagram-root" style={{ height: '100%', position: 'relative' }}>
      <DiagramToolbar
        hideSystem={hideSystem}
        onToggleHideSystem={setHideSystem}
        collapseRepeats={collapseRepeats}
        onToggleCollapseRepeats={setCollapseRepeats}
        onExpandAll={() => setCollapsedUnits(new Set())}
        onCollapseAll={() => setCollapsedUnits(new Set(allUnitIds))}
        colorsByKind={colorsByKind}
      />
      {frames.length === 0 ? (
        <div style={{ padding: 8, opacity: 0.8 }}>No flow detected.</div>
      ) : (
        <DiagramCanvas
          frames={frames}
          styleByKind={styleByKind}
          methodActorSet={methodActorSet}
          collapsedUnits={collapsedUnits}
          onToggleUnit={(id: string) => {
            setCollapsedUnits(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

