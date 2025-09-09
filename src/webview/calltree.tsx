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

type Mode = 'tree' | 'backtraces' | 'merged';

function App() {
  const [graph, setGraph] = useState<LogGraph | undefined>(undefined);
  const [model, setModel] = useState<CallTreeModel | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('tree');
  const [selectedSig, setSelectedSig] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<{ mode: Mode; sig?: string }[]>([]);

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
    } catch (e) {
      console.warn('CallTree: build failed', e);
    }
  }, [graph]);

  // Derived view model depending on mode/selection
  const viewModel: CallTreeModel | undefined = useMemo(() => {
    if (!model) return undefined;
    if (mode === 'tree' || !selectedSig) return model;
    if (mode === 'backtraces') return invertForSignature(model, selectedSig);
    if (mode === 'merged') return mergeOccurrences(model, selectedSig);
    return model;
  }, [model, mode, selectedSig]);

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

  const onToggle = (id: string) => {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const onScope = (n: CallTreeNode) => {
    const sig = `${n.ref.className}#${n.ref.method}`;
    setHistory(h => [...h, { mode, sig: selectedSig }]);
    setSelectedSig(sig);
    setMode('tree');
    setCollapsed(new Set());
  };

  const onMerged = (n: CallTreeNode) => {
    const sig = `${n.ref.className}#${n.ref.method}`;
    setHistory(h => [...h, { mode, sig: selectedSig }]);
    setSelectedSig(sig);
    setMode('merged');
    setCollapsed(new Set());
  };

  const onBacktraces = (n: CallTreeNode) => {
    const sig = `${n.ref.className}#${n.ref.method}`;
    setHistory(h => [...h, { mode, sig: selectedSig }]);
    setSelectedSig(sig);
    setMode('backtraces');
    setCollapsed(new Set());
  };

  const canBack = history.length > 0;
  const onBack = () => {
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    if (prev) {
      setMode(prev.mode);
      setSelectedSig(prev.sig);
      setCollapsed(new Set());
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        html, body, #root { height: 100%; }
        body { margin: 0; }
        .toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; }
        .tree { padding: 4px 10px 20px; overflow:auto; flex: 1; }
        .node { line-height: 1.6; }
        .label { cursor: default; }
        .dim { opacity: 0.7; }
        .controls button { margin-left: 4px; }
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
        <span className="dim">Total: {fmtMs(total)}</span>
        <span className="dim">Mode: {mode}</span>
      </div>
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
          />
        ))}
        {roots.length === 0 && <div style={{ opacity: 0.8 }}>No calls.</div>}
      </div>
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
  onBacktraces
}: {
  node: CallTreeNode;
  total: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onScope: (n: CallTreeNode) => void;
  onMerged: (n: CallTreeNode) => void;
  onBacktraces: (n: CallTreeNode) => void;
}) {
  const id = node.id;
  const isCollapsed = collapsed.has(id);
  const own = node.metrics.ownTimeMs || 0;
  const tot = node.metrics.totalTimeMs || 0;
  const cls = classShort(node.ref.className);
  const name = `${cls}.${node.ref.method}`;
  const suffix = node.metrics.count && node.metrics.count > 1 ? ` ×${node.metrics.count}` : '';

  return (
    <div className="node" style={{ marginLeft: 12 }}>
      <div className="label" onDoubleClick={() => onToggle(id)}>
        <button type="button" onClick={() => onToggle(id)} style={{ width: 22 }}>
          {node.children.length ? (isCollapsed ? '▸' : '▾') : '·'}
        </button>
        <strong>{name}</strong>
        {suffix ? <span className="dim"> {suffix}</span> : null}
        <span className="dim"> — own {fmtMs(own)} ({percent(own, total)}), total {fmtMs(tot)}</span>
        <span className="controls">
          <button type="button" onClick={() => onScope(node)} title="Scope to This (Ctrl+Enter)">Scope</button>
          <button type="button" onClick={() => onMerged(node)} title="Merge occurrences (Ctrl+Shift+Enter)">Merge</button>
          <button type="button" onClick={() => onBacktraces(node)} title="Backtraces">Backtraces</button>
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
        />
      ))}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
