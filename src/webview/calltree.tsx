import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LogGraph } from '../shared/apexLogParser/types';
import { buildCallTree, invertForSignature, mergeOccurrences } from '../shared/callTree';
import type { CallTreeModel, CallTreeNode } from '../shared/callTree';

declare global {
  var acquireVsCodeApi: <T = unknown>() => {
    postMessage: (msg: T) => void;
    getState: <S = any>() => S | undefined;
    setState: (state: any) => void;
  };
}

type WebToExt = { type: 'ready' };
type ExtToWeb = { type: 'graph'; graph: LogGraph };

const vscode = acquireVsCodeApi<WebToExt>();

function fmtMs(n: number | undefined): string {
  if (!n || n <= 0) return '0 ms';
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  return `${s.toFixed(s >= 10 ? 0 : 1)} s`;
}

function percent(n: number, total: number): string {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(n / total >= 0.1 ? 1 : 2)}%`;
}

function classShort(name: string): string {
  const parts = (name || '').split('.');
  return parts[parts.length - 1] || name;
}

type Kind = 'Trigger' | 'Flow' | 'Class' | 'Other';
function kindFromActor(actor?: string): Kind {
  if (!actor) return 'Other';
  if (actor.startsWith('Trigger:')) return 'Trigger';
  if (actor.startsWith('Flow:')) return 'Flow';
  if (actor.startsWith('Class:')) return 'Class';
  return 'Other';
}
function colorsFor(kind: Kind): { stroke: string; fill: string } {
  switch (kind) {
    case 'Trigger':
      return { stroke: '#60a5fa', fill: 'rgba(96,165,250,0.16)' };
    case 'Flow':
      return { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.16)' };
    case 'Class':
      return { stroke: '#34d399', fill: 'rgba(52,211,153,0.16)' };
    default:
      return { stroke: 'rgba(148,163,184,0.7)', fill: 'rgba(148,163,184,0.12)' };
  }
}

type Mode = 'tree' | 'backtraces' | 'merged' | 'flame';

function App() {
  const [graph, setGraph] = useState<LogGraph | undefined>(undefined);
  const [model, setModel] = useState<CallTreeModel | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('tree');
  const [selectedSig, setSelectedSig] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<{ mode: Mode; sig?: string; scopedId?: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [scopedId, setScopedId] = useState<string | undefined>(undefined);

  // Listen for messages and ask for initial data
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data as ExtToWeb;
      if (msg?.type === 'graph') {
        setGraph(msg.graph);
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Build base model from nested frames
  useEffect(() => {
    if (!graph) return;
    try {
      const base = buildCallTree(graph.nested || []);
      setModel(base);
      setMode('tree');
      setSelectedSig(undefined);
      setCollapsed(new Set());
      setSelectedId(undefined);
    } catch (e) {
      console.warn('CallTree: build failed', e);
    }
  }, [graph]);

  // Derived view model depending on mode/selection
  const viewModel: CallTreeModel | undefined = useMemo(() => {
    if (!model) return undefined;
    if (mode === 'backtraces' && selectedSig) return invertForSignature(model, selectedSig);
    if (mode === 'merged' && selectedSig) return mergeOccurrences(model, selectedSig);
    // Treat 'tree' and 'flame' similarly; allow scoping by occurrence id
    if (scopedId) {
      const { scopeToOccurrence } = require('../shared/callTree');
      return scopeToOccurrence(model, scopedId);
    }
    return model;
  }, [model, mode, selectedSig, scopedId]);

  // Filter roots by search
  const roots = useMemo(() => {
    const r = viewModel?.roots || [];
    if (!filter.trim()) return r;
    const f = filter.trim().toLowerCase();
    const matches = (n: CallTreeNode): boolean =>
      n.ref.method.toLowerCase().includes(f) ||
      n.ref.className.toLowerCase().includes(f) ||
      `${n.ref.className}.${n.ref.method}`.toLowerCase().includes(f);
    // If filter, show roots that match or that have any matching descendants
    const filtered: CallTreeNode[] = [];
    const visit = (n: CallTreeNode): boolean => {
      const childHas = n.children?.some(visit) || false;
      return matches(n) || childHas;
    };
    for (const r0 of r) if (visit(r0)) filtered.push(r0);
    return filtered;
  }, [viewModel, filter]);

  const total = viewModel?.totals.totalTimeMs || 0;

  // Aggregate counters for subtitle
  const agg = useMemo(() => {
    const res = { soql: 0, dml: 0, callout: 0, soqlTimeMs: 0, dmlTimeMs: 0, calloutTimeMs: 0 };
    if (!viewModel) return res;
    const stack = [...(viewModel.roots || [])];
    while (stack.length) {
      const n = stack.pop()!;
      res.soql += n.metrics.soql || 0;
      res.dml += n.metrics.dml || 0;
      res.callout += n.metrics.callout || 0;
      res.soqlTimeMs += n.metrics.soqlTimeMs || 0;
      res.dmlTimeMs += n.metrics.dmlTimeMs || 0;
      res.calloutTimeMs += n.metrics.calloutTimeMs || 0;
      for (const c of n.children) stack.push(c);
    }
    return res;
  }, [viewModel]);
  const onToggle = (id: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const onScope = (n: CallTreeNode) => {
    setHistory(h => [...h, { mode, sig: selectedSig, scopedId }]);
    setScopedId(n.id);
    setMode('tree');
    setCollapsed(new Set());
    setSelectedId(n.id);
  };

  const onMerged = (n: CallTreeNode) => {
    const sig = `${n.ref.className}#${n.ref.method}`;
    setHistory(h => [...h, { mode, sig: selectedSig, scopedId }]);
    setSelectedSig(sig);
    setMode('merged');
    setCollapsed(new Set());
    setSelectedId(undefined);
    setScopedId(undefined);
  };

  const onBacktraces = (n: CallTreeNode) => {
    const sig = `${n.ref.className}#${n.ref.method}`;
    setHistory(h => [...h, { mode, sig: selectedSig, scopedId }]);
    setSelectedSig(sig);
    setMode('backtraces');
    setCollapsed(new Set());
    setSelectedId(undefined);
    setScopedId(undefined);
  };

  const canBack = history.length > 0;
  const onBack = () => {
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    if (prev) {
      setMode(prev.mode);
      setSelectedSig(prev.sig);
      setScopedId(prev.scopedId);
      setCollapsed(new Set());
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Next Important Call: Ctrl+Shift+Right
      if (e.ctrlKey && e.shiftKey && e.key === 'ArrowRight') {
        e.preventDefault();
        nextImportant();
      }
      // Scope to This: Ctrl+Enter
      if (e.ctrlKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const n = selectedNode();
        if (n) onScope(n);
      }
      // Merge occurrences: Ctrl+Shift+Enter
      if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        const n = selectedNode();
        if (n) onMerged(n);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, viewModel, mode, selectedSig]);

  // Helpers for selection and important calls
  const flatten = (nodes: CallTreeNode[]): CallTreeNode[] => {
    const out: CallTreeNode[] = [];
    const st = nodes.slice().reverse();
    while (st.length) {
      const n = st.pop()!;
      out.push(n);
      for (let i = n.children.length - 1; i >= 0; i--) st.push(n.children[i]!);
    }
    return out;
  };
  const selectedNode = (): CallTreeNode | undefined => {
    if (!viewModel || !selectedId) return undefined;
    return viewModel.all.get(selectedId);
  };
  const importantNodes = useMemo(() => {
    if (!viewModel) return [] as CallTreeNode[];
    const nodes = flatten(viewModel.roots);
    const baseTotal = viewModel.totals.totalTimeMs || 0;
    const threshold = Math.max(1, Math.round(baseTotal * 0.1)); // 10% of total
    const filtered = nodes.filter(n => (n.metrics.ownTimeMs || 0) >= threshold);
    // Fallback to top 10 by own time if none over threshold
    const list = filtered.length ? filtered : nodes.sort((a, b) => (b.metrics.ownTimeMs || 0) - (a.metrics.ownTimeMs || 0)).slice(0, 10);
    return list;
  }, [viewModel]);
  const nextImportant = () => {
    if (!importantNodes.length) return;
    const idx = importantNodes.findIndex(n => n.id === selectedId);
    const nxt = importantNodes[(idx + 1) % importantNodes.length];
    if (nxt) setSelectedId(nxt.id);
  };
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        html, body, #root { height: 100%; }
        body { margin: 0; }
        .toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; }
        .tree { padding: 4px 10px 20px; overflow:auto; flex: 1; }
        .node { line-height: 1.6; }
        .label { cursor: default; padding: 6px 8px; border: 1px solid var(--vscode-editorGroup-border, rgba(148,163,184,0.30)); border-radius: 10px; margin: 6px 0; display: inline-flex; align-items: center; gap: 6px; }
        .dim { opacity: 0.7; }
        .chip { border-radius: 8px; padding: 3px 10px; border: 1px solid var(--vscode-focusBorder, rgba(148,163,184,0.6)); background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
        .chip:hover { filter: brightness(1.03); }
        .controls button { margin-left: 4px; }
        .soft { background: var(--vscode-editorHoverWidget-background); }
      `}</style>
      <div className="toolbar">
        <button type="button" disabled={!canBack} onClick={onBack} title="Back">◀</button>
        <input
          type="text"
          placeholder="Find class or method…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className="chip" onClick={() => setMode(mode === 'flame' ? 'tree' as Mode : 'flame')} title="Flame Graph">
          {mode === 'flame' ? 'Tree' : 'Flame Graph'}
        </button>
        <button type="button" className="chip" onClick={nextImportant} title="Next Important Call (Ctrl+Shift+Right)">Next Important</button>
        <span className="dim">Total: {fmtMs(total)}</span>
        {(agg.soql || agg.dml || agg.callout) ? (
          <span className="dim">
            • S{agg.soql}{agg.soqlTimeMs ? `(${agg.soqlTimeMs}ms)` : ''}
            {agg.dml ? ` D${agg.dml}${agg.dmlTimeMs ? `(${agg.dmlTimeMs}ms)` : ''}` : ''}
            {agg.callout ? ` C${agg.callout}${agg.calloutTimeMs ? `(${agg.calloutTimeMs}ms)` : ''}` : ''}
          </span>
        ) : null}
        <span className="dim">Mode: {mode}</span>
      </div>
      {mode === 'flame' ? (
        <FlameGraph roots={roots} total={total} onSelect={n => setSelectedId(n.id)} onScope={onScope} selectedId={selectedId} />
      ) : (
        <div className="tree">
          {roots.map(r => (
            <TreeNode
              key={r.id}
              node={r}
              total={total}
              collapsed={collapsed}
              onToggle={onToggle}
              onScope={onScope}
              onMerged={onMerged}
              onBacktraces={onBacktraces}
              selectedId={selectedId}
              onSelect={n => setSelectedId(n.id)}
            />
          ))}
          {roots.length === 0 && <div style={{ opacity: 0.8 }}>No calls.</div>}
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  total,
  collapsed,
  onToggle,
  onScope,
  onMerged,
  onBacktraces,
  selectedId,
  onSelect
}: {
  node: CallTreeNode;
  total: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onScope: (n: CallTreeNode) => void;
  onMerged: (n: CallTreeNode) => void;
  onBacktraces: (n: CallTreeNode) => void;
  selectedId?: string;
  onSelect?: (n: CallTreeNode) => void;
}) {
  const id = node.id;
  const isCollapsed = collapsed.has(id);
  const own = node.metrics.ownTimeMs || 0;
  const tot = node.metrics.totalTimeMs || 0;
  const cls = classShort(node.ref.className);
  const name = `${cls}.${node.ref.method}`;
  const suffix = node.metrics.count && node.metrics.count > 1 ? ` ×${node.metrics.count}` : '';
  const selected = selectedId === id;
  const k = kindFromActor(node.actor);
  const col = colorsFor(k);

  return (
    <div className="node" style={{ marginLeft: 12 }}>
      <div
        className="label"
        onDoubleClick={() => onToggle(id)}
        onClick={() => onSelect?.(node)}
        style={{
          background: selected ? 'var(--vscode-list-hoverBackground)' : col.fill,
          borderColor: col.stroke,
          boxShadow: selected ? `0 0 0 1px ${col.stroke} inset` : undefined,
          borderLeft: `4px solid ${col.stroke}`
        }}
      >
        <button type="button" className="chip" onClick={() => onToggle(id)} style={{ width: 24 }}>
          {node.children.length ? (isCollapsed ? '▸' : '▾') : '·'}
        </button>
        <strong>{name}</strong>
        {suffix ? <span className="dim"> {suffix}</span> : null}
        <span className="dim"> — own {fmtMs(own)} ({percent(own, total)}), total {fmtMs(tot)}</span>
        {(node.metrics.soql || node.metrics.dml || node.metrics.callout) && (
          <span className="dim" style={{ marginLeft: 6 }}>
            [
            {node.metrics.soql ? `S${node.metrics.soql}${node.metrics.soqlTimeMs ? `(${node.metrics.soqlTimeMs}ms)` : ''}` : 'S0'}
            {node.metrics.dml ? ` D${node.metrics.dml}${node.metrics.dmlTimeMs ? `(${node.metrics.dmlTimeMs}ms)` : ''}` : ''}
            {node.metrics.callout ? ` C${node.metrics.callout}${node.metrics.calloutTimeMs ? `(${node.metrics.calloutTimeMs}ms)` : ''}` : ''}
            ]
          </span>
        )}
        <span className="controls">
          <button type="button" className="chip" onClick={() => onScope(node)} title="Scope to This (Ctrl+Enter)">Scope</button>
          <button type="button" className="chip" onClick={() => onMerged(node)} title="Merge occurrences (Ctrl+Shift+Enter)">Merge</button>
          <button type="button" className="chip" onClick={() => onBacktraces(node)} title="Backtraces">Backtraces</button>
        </span>
      </div>
      {!isCollapsed && node.children.map(c => (
        <TreeNode
          key={c.id}
          node={c}
          total={total}
          collapsed={collapsed}
          onToggle={onToggle}
          onScope={onScope}
          onMerged={onMerged}
          onBacktraces={onBacktraces}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function FlameGraph({
  roots,
  total,
  onSelect,
  onScope,
  selectedId
}: {
  roots: CallTreeNode[];
  total: number;
  onSelect: (n: CallTreeNode) => void;
  onScope: (n: CallTreeNode) => void;
  selectedId?: string;
}) {
  const width = Math.max(600, Math.min(1400, (total || 1) * 4));
  const rowH = 22;
  const pad = 8;
  const scale = (total || 1) > 0 ? (width - pad * 2) / (total || 1) : 1;
  const blocks: Array<{ n: CallTreeNode; x: number; y: number; w: number; h: number }> = [];
  const walk = (n: CallTreeNode, x: number, depth: number) => {
    const w = Math.max(1, Math.round((n.metrics.totalTimeMs || 0) * scale));
    const y = pad + depth * rowH;
    blocks.push({ n, x, y, w, h: rowH - 4 });
    let cx = x;
    for (const c of n.children) {
      const cw = Math.max(1, Math.round((c.metrics.totalTimeMs || 0) * scale));
      walk(c, cx, depth + 1);
      cx += cw;
    }
  };
  let x0 = pad;
  for (const r of roots) {
    const w = Math.max(1, Math.round((r.metrics.totalTimeMs || 0) * scale));
    walk(r, x0, 0);
    x0 += w;
  }
  const maxDepth = blocks.reduce((m, b) => Math.max(m, (b.y - pad) / rowH), 0) as number;
  const height = pad + (maxDepth + 1) * rowH + pad;

  const textFor = (n: CallTreeNode) => {
    const base = `${classShort(n.ref.className)}.${n.ref.method}`;
    const counts = [
      n.metrics.soql ? `S${n.metrics.soql}` : '',
      n.metrics.dml ? `D${n.metrics.dml}` : '',
      n.metrics.callout ? `C${n.metrics.callout}` : ''
    ].filter(Boolean);
    return counts.length && base.length < 32 ? `${base}  [${counts.join(' ')}]` : base;
  };

  return (
    <div className="tree" style={{ overflow: 'auto' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {blocks.map(b => {
          const selected = selectedId === b.n.id;
          const label = textFor(b.n);
          const kind = kindFromActor(b.n.actor);
          const col = colorsFor(kind);
          return (
            <g key={`${b.n.id}`}>
              <rect
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={3}
                ry={3}
                fill={selected ? col.fill : col.fill}
                stroke={selected ? col.stroke : col.stroke}
                strokeWidth={selected ? 2 : 1}
                onClick={() => onSelect(b.n)}
                onDoubleClick={() => onScope(b.n)}
              />
              {b.w > 40 && (
                <text x={b.x + 6} y={b.y + b.h / 2 + 4} fontSize={12} fill={'var(--vscode-foreground)'}>
                  {label}
                </text>
              )}
              <title>
                {label}\nOwn {fmtMs(b.n.metrics.ownTimeMs)} ({percent(b.n.metrics.ownTimeMs || 0, total)}), Total {fmtMs(b.n.metrics.totalTimeMs)}
                {(b.n.metrics.soql || b.n.metrics.dml || b.n.metrics.callout) ? `\nS${b.n.metrics.soql || 0}${b.n.metrics.soqlTimeMs ? ` (${b.n.metrics.soqlTimeMs}ms)` : ''}` : ''}
                {b.n.metrics.dml ? ` D${b.n.metrics.dml}${b.n.metrics.dmlTimeMs ? ` (${b.n.metrics.dmlTimeMs}ms)` : ''}` : ''}
                {b.n.metrics.callout ? ` C${b.n.metrics.callout}${b.n.metrics.calloutTimeMs ? ` (${b.n.metrics.calloutTimeMs}ms)` : ''}` : ''}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
