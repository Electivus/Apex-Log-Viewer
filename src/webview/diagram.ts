/* Simple left-to-right flow diagram (no external libs). */
declare function acquireVsCodeApi(): any;

type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  flow?: unknown[];
};

const vscode = acquireVsCodeApi();

function h(tag: string, attrs?: Record<string, any>, children?: (Node | string | null | undefined)[]): HTMLElement | SVGElement {
  const el = tag === 'svg' || tag === 'path' || tag === 'defs' || tag === 'marker' || tag === 'line' || tag === 'text'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = (attrs as any)[k];
      if (k === 'style' && typeof v === 'object') Object.assign((el as HTMLElement).style, v);
      else if (k === 'class') (el as any).className = v;
      else if (v !== undefined && v !== null) (el as any).setAttribute?.(k, String(v));
    }
  }
  if (children) for (const c of children) { if (c == null) continue; (typeof c === 'string') ? el.appendChild(document.createTextNode(c)) : el.appendChild(c); }
  return el;
}

function truncate(s: string, max = 38): string { return s && s.length > max ? s.slice(0, max - 1) + '…' : (s || ''); }

function buildSimplePath(graph: Graph) {
  const used: string[] = [];
  let last: string | undefined;
  for (const ev of graph.sequence || []) {
    const cur = ev.to;
    if (!cur) continue;
    if (cur !== last) {
      used.push(cur);
      last = cur;
    }
  }
  return used;
}

function render(graph: Graph) {
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  const order = buildSimplePath(graph);
  if (order.length === 0) {
    root.appendChild(h('div', { style: { padding: '8px', opacity: 0.8 } }, ['No flow detected.']));
    return;
  }
  const nodesById = new Map(graph.nodes.map(n => [n.id, n] as const));

  const W = 240, H = 120, GAP = 36, PAD = 16;
  const totalW = PAD + order.length * (W + GAP) - GAP + PAD;
  const totalH = H + PAD * 2;

  const svg = h('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}` }) as SVGSVGElement;
  const defs = h('defs');
  defs.appendChild(h('marker', { id: 'arrow', markerWidth: 10, markerHeight: 8, refX: 10, refY: 4, orient: 'auto', markerUnits: 'strokeWidth' }, [
    h('path', { d: 'M0,0 L10,4 L0,8 z', fill: 'var(--vscode-editor-foreground, #888)' })
  ]));
  svg.appendChild(defs);

  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const x = PAD + i * (W + GAP);
    const y = PAD;
    const n = nodesById.get(id);
    const label = truncate(n?.label || id.split(':').slice(1).join(':'), 36);
    // Box
    svg.appendChild(h('rect', { x, y, rx: 8, ry: 8, width: W, height: H, fill: 'var(--vscode-editorWidget-background, rgba(127,127,127,0.15))', stroke: 'var(--vscode-editorWidget-border, rgba(127,127,127,0.35))' }));
    // Title
    const title = h('text', { x: x + 12, y: y + 24, fill: 'var(--vscode-foreground)', 'font-weight': 600, 'font-size': 13 }, [label]);
    (title as any).style.fontWeight = '600';
    svg.appendChild(title);
    // Kind
    if (n?.kind) svg.appendChild(h('text', { x: x + 12, y: y + 44, fill: 'var(--vscode-foreground)', 'font-size': 11, opacity: 0.75 }, [n.kind]));
    // Arrow to next
    if (i < order.length - 1) {
      const x1 = x + W;
      const x2 = x + W + GAP;
      const midY = y + H / 2;
      svg.appendChild(h('line', { x1, y1: midY, x2, y2: midY, stroke: 'var(--vscode-editor-foreground, #888)', 'stroke-width': 2, 'marker-end': 'url(#arrow)' }));
    }
  }

  // Scroll container to fit horizontally
  const scroller = h('div', { style: { overflowX: 'auto', overflowY: 'hidden' } }, [svg]);
  root.appendChild(scroller);
}

window.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'graph') render(msg.graph || { nodes: [], sequence: [] });
});

document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
