/* Simple left-to-right flow diagram (no external libs). */
declare function acquireVsCodeApi(): any;

type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  nested?: { actor: string; label: string; start: number; end?: number; depth: number; kind: 'unit' | 'method' }[];
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

function render(graph: Graph) {
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  const frames = (graph.nested || []).slice();
  if (frames.length === 0) {
    root.appendChild(h('div', { style: { padding: '8px', opacity: 0.8 } }, ['No flow detected.']));
    return;
  }

  const PAD = 16; // outer padding
  const ROW = 26; // vertical step per sequence index
  const IND = 18; // indent per depth (x)
  const W0 = Math.max(360, (root.clientWidth || 800) - PAD * 2);
  const MAX_DEPTH = Math.max(0, ...frames.map(f => f.depth));
  const width = W0; // overall width used by depth=0; inner boxes shrink by depth*IND*2
  const totalH = PAD + Math.max(...frames.map(f => (f.end ?? f.start + 1))) * ROW + PAD;

  const svg = h('svg', { width: width + PAD * 2, height: totalH, viewBox: `0 0 ${width + PAD * 2} ${totalH}` }) as SVGSVGElement;

  // Draw frames (outer to inner ensures borders visible): iterate by ascending depth
  frames.sort((a, b) => a.depth - b.depth || a.start - b.start);

  for (const fr of frames) {
    const x = PAD + fr.depth * IND;
    const w = Math.max(40, width - fr.depth * IND * 2);
    const y1 = PAD + fr.start * ROW + 3;
    const y2 = PAD + (fr.end ?? fr.start + 1) * ROW - 3;
    const rectH = Math.max(14, y2 - y1);
    const stroke = fr.kind === 'unit' ? 'var(--vscode-foreground, #ccc)' : 'var(--vscode-editorWidget-border, rgba(127,127,127,0.35))';
    const fill = 'var(--vscode-editorWidget-background, rgba(127,127,127,0.12))';
    svg.appendChild(h('rect', { x, y: y1, width: w, height: rectH, rx: 8, ry: 8, fill, stroke, 'stroke-width': fr.kind === 'unit' ? 1.5 : 1 }));
    const label = truncate(fr.label.replace(/^Class\./, ''), 80);
    svg.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
  }

  const scroller = h('div', { style: { overflowY: 'auto', overflowX: 'hidden' } }, [svg]);
  root.appendChild(scroller);
}

window.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'graph') render(msg.graph || { nodes: [], sequence: [], nested: [] });
});

document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
