/* Simple left-to-right flow diagram (no external libs). */
declare function acquireVsCodeApi(): any;

type Nested = { actor: string; label: string; start: number; end?: number; depth: number; kind: 'unit' | 'method' };
type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  nested?: Nested[];
};

const vscode = acquireVsCodeApi();

function h(tag: string, attrs?: Record<string, any>, children?: (Node | string | null | undefined)[]): HTMLElement | SVGElement {
  const svgTags = new Set(['svg', 'path', 'defs', 'marker', 'line', 'text', 'rect', 'g', 'title']);
  const el = svgTags.has(tag)
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

function ensureStyles() {
  if (document.getElementById('apex-diagram-styles')) return;
  const style = document.createElement('style');
  style.id = 'apex-diagram-styles';
  style.textContent = `
    html, body, #root { height: 100%; }
    body { margin: 0; }
    #root { position: relative; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 6px 10px; position: relative; }
    .legend { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; opacity: 0.9; font-size: 12px; }
    .legend .item { display: inline-flex; align-items: center; gap: 4px; }
    .legend .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  `;
  document.head.appendChild(style);
}

let currentGraph: Graph | undefined;
let hideSystem = true;
let collapseRepeats = true;

function kindFromActor(actor: string): 'Trigger' | 'Flow' | 'Class' | 'Other' {
  if (actor.startsWith('Trigger:')) return 'Trigger';
  if (actor.startsWith('Flow:')) return 'Flow';
  if (actor.startsWith('Class:')) return 'Class';
  return 'Other';
}
function styleByKind(kind: 'Trigger' | 'Flow' | 'Class' | 'Other') {
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

function filterAndCollapse(frames: Nested[] | undefined): (Nested & { count?: number })[] {
  let list: Nested[] = (frames || []).slice();
  if (hideSystem) {
    list = list.filter(fr => !/^Class:System\b/.test(fr.actor) && !/^System\./.test(fr.label));
  }
  // Collapse consecutive repeats on same lane, same depth and same label
  list.sort((a, b) => a.start - b.start || a.depth - b.depth);
  if (!collapseRepeats) return list as any;
  const out: (Nested & { count?: number })[] = [];
  for (const f of list) {
    const prev = out[out.length - 1];
    if (prev && prev.actor === f.actor && prev.depth === f.depth && prev.label === f.label && (prev.end ?? prev.start) <= f.start) {
      prev.end = f.end ?? f.start + 1;
      prev.count = (prev.count || 1) + 1;
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

function render(graph: Graph) {
  ensureStyles();
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  currentGraph = graph;
  const frames = filterAndCollapse(graph.nested || []);
  if (frames.length === 0) {
    root.appendChild(h('div', { style: { padding: '8px', opacity: 0.8 } }, ['No flow detected.']));
    return;
  }

  // Toolbar with toggles + legend
  const toolbar = h('div', { class: 'toolbar' }, [
    h('label', {}, [
      h('input', { type: 'checkbox', checked: hideSystem ? 'checked' : undefined, onchange: (e: any) => { hideSystem = !!e.target.checked; if (currentGraph) render(currentGraph); } }, []),
      ' Hide System'
    ]),
    h('label', {}, [
      h('input', { type: 'checkbox', checked: collapseRepeats ? 'checked' : undefined, onchange: (e: any) => { collapseRepeats = !!e.target.checked; if (currentGraph) render(currentGraph); } }, []),
      ' Collapse repeats'
    ]),
    h('div', { class: 'legend' }, [
      h('span', { class: 'item' }, [h('span', { class: 'swatch', style: { background: styleByKind('Trigger').fill, border: `1px solid ${styleByKind('Trigger').stroke}` } }, []), 'Trigger']),
      h('span', { class: 'item' }, [h('span', { class: 'swatch', style: { background: styleByKind('Flow').fill, border: `1px solid ${styleByKind('Flow').stroke}` } }, []), 'Flow']),
      h('span', { class: 'item' }, [h('span', { class: 'swatch', style: { background: styleByKind('Class').fill, border: `1px solid ${styleByKind('Class').stroke}` } }, []), 'Class']),
      h('span', { class: 'item' }, [h('span', { class: 'swatch', style: { background: styleByKind('Other').fill, border: `1px solid ${styleByKind('Other').stroke}` } }, []), 'Other'])
    ])
  ]);
  root.appendChild(toolbar);

  const PAD = 16; // outer padding
  const ROW = 26; // vertical step per sequence index
  const IND = 18; // indent per depth (x)
  const viewportW = (document.documentElement.clientWidth || window.innerWidth || 800) - 24;
  const W0 = Math.max(360, (root.clientWidth || viewportW) - PAD * 2);
  const MAX_DEPTH = Math.max(0, ...frames.map(f => f.depth));
  const width = W0; // overall width used by depth=0; inner boxes shrink by depth*IND*2
  const totalH = PAD + Math.max(...frames.map(f => (f.end ?? f.start + 1))) * ROW + PAD;

  const svgW = width + PAD * 2 + 12; // right-side breathing room
  const svgH = totalH + 12; // bottom breathing room
  const svg = h('svg', { width: svgW, height: svgH, viewBox: `0 0 ${svgW} ${svgH}` }) as SVGSVGElement;

  // Draw frames (outer to inner ensures borders visible): iterate by ascending depth
  frames.sort((a, b) => a.depth - b.depth || a.start - b.start);

  for (const fr of frames) {
    const x = PAD + fr.depth * IND;
    const w = Math.max(40, width - fr.depth * IND * 2);
    const y1 = PAD + fr.start * ROW + 3;
    const y2 = PAD + (fr.end ?? fr.start + 1) * ROW - 3;
    const rectH = Math.max(14, y2 - y1);
    const kind = kindFromActor(fr.actor);
    const sty = styleByKind(kind);
    const g = h('g');
    g.appendChild(h('rect', { x, y: y1, width: w, height: rectH, rx: 8, ry: 8, fill: sty.fill, stroke: sty.stroke, 'stroke-width': fr.kind === 'unit' ? 1.6 : 1 }));
    const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
    const label = truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix;
    g.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
    // Tooltip with full label
    g.appendChild(h('title', {}, [fr.label]));
    svg.appendChild(g);
  }

  const scroller = h('div', { style: { position: 'absolute', top: '36px', left: '0', right: '0', bottom: '0', overflowY: 'auto', overflowX: 'auto' } }, [svg]);
  root.appendChild(scroller);
}

window.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'graph') render(msg.graph || { nodes: [], sequence: [], nested: [] });
});

document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
