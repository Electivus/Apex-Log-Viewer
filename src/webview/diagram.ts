/* Simple left-to-right flow diagram (no external libs). */
declare function acquireVsCodeApi(): any;

type Nested = { actor: string; label: string; start: number; end?: number; depth: number; kind: 'unit' | 'method' };
type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  nested?: Nested[];
};

const vscode = acquireVsCodeApi();

function h(
  tag: string,
  attrs?: Record<string, any>,
  children?: (Node | string | null | undefined)[]
): HTMLElement | SVGElement {
  const svgTags = new Set(['svg', 'path', 'defs', 'marker', 'line', 'text', 'rect', 'g', 'title']);
  const htmlTags = new Set(['div', 'label', 'span', 'input', 'button']);
  const el = svgTags.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = (attrs as any)[k];
      if (k === 'style' && typeof v === 'object') Object.assign((el as HTMLElement).style, v);
      else if (k === 'class') (el as Element).setAttribute('class', String(v));
      else if (k.startsWith('on') && typeof v === 'function') (el as any)[k] = v;
      else if (v !== undefined && v !== null) {
        // Allowlist of safe attributes (prevents event/href/src injection and satisfies CodeQL)
        const allowed = new Set([
          'id',
          'class',
          'type',
          'checked',
          'viewBox',
          // Position/geometry
          'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'rx', 'ry',
          // Styling
          'fill', 'stroke', 'stroke-width', 'font-size'
        ]);
        if (allowed.has(k)) (el as any).setAttribute?.(k, String(v));
      }
    }
  }
  if (children)
    for (const c of children) {
      if (c === null || c === undefined) continue;
      if (typeof c === 'string') {
        el.appendChild(document.createTextNode(c));
      } else if (c instanceof Node) {
        // Only allow known-safe node types/tags
        if (c.nodeType === Node.TEXT_NODE) {
          el.appendChild(c);
        } else if (c instanceof SVGElement) {
          if (svgTags.has((c as Element).tagName.toLowerCase())) el.appendChild(c);
        } else if (c instanceof HTMLElement) {
          if (htmlTags.has((c as Element).tagName.toLowerCase())) el.appendChild(c);
        }
      }
    }
  return el;
}

function truncate(s: string, max = 38): string {
  return s && s.length > max ? s.slice(0, max - 1) + '…' : s || '';
}

function sanitizeText(s: string): string {
  if (!s) return '';
  // Remove control chars except common whitespace; keep visible text intact.
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

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
let collapsedUnits = new Set<string>();
let allUnitIds: string[] = [];
let collapseInitialized = false;

function unitId(fr: Nested): string {
  return `${fr.actor}:${fr.start}`;
}

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

function render(graph: Graph) {
  ensureStyles();
  const root = document.getElementById('root')!;
  // Avoid innerHTML for clearing to keep CodeQL happy and be safer
  while (root.firstChild) root.removeChild(root.firstChild);

  currentGraph = graph;
  const frames = filterAndCollapse(graph.nested || []);
  const methodActorSet = new Set<string>();
  for (const fr of frames) if (fr.kind === 'method') methodActorSet.add(fr.actor);
  if (frames.length === 0) {
    root.appendChild(h('div', { style: { padding: '8px', opacity: 0.8 } }, ['No flow detected.']));
    return;
  }

  const unitIds = frames.filter(f => f.kind === 'unit').map(unitId);
  allUnitIds = unitIds;
  collapsedUnits = collapseInitialized ? new Set(unitIds.filter(id => collapsedUnits.has(id))) : new Set(unitIds);
  collapseInitialized = true;

  // Toolbar with toggles + legend
  const toolbar = h('div', { class: 'toolbar' }, [
    h('label', {}, [
      h(
        'input',
        {
          type: 'checkbox',
          checked: hideSystem ? 'checked' : undefined,
          onchange: (e: any) => {
            hideSystem = !!e.target.checked;
            if (currentGraph) render(currentGraph);
          }
        },
        []
      ),
      ' Hide System'
    ]),
    h('label', {}, [
      h(
        'input',
        {
          type: 'checkbox',
          checked: collapseRepeats ? 'checked' : undefined,
          onchange: (e: any) => {
            collapseRepeats = !!e.target.checked;
            if (currentGraph) render(currentGraph);
          }
        },
        []
      ),
      ' Collapse repeats'
    ]),
    h(
      'button',
      {
        onclick: () => {
          collapsedUnits.clear();
          if (currentGraph) render(currentGraph);
        }
      },
      ['Expand all']
    ),
    h(
      'button',
      {
        onclick: () => {
          collapsedUnits = new Set(allUnitIds);
          if (currentGraph) render(currentGraph);
        }
      },
      ['Collapse all']
    ),
    h('div', { class: 'legend' }, [
      h('span', { class: 'item' }, [
        h(
          'span',
          {
            class: 'swatch',
            style: { background: styleByKind('Trigger').fill, border: `1px solid ${styleByKind('Trigger').stroke}` }
          },
          []
        ),
        'Trigger'
      ]),
      h('span', { class: 'item' }, [
        h(
          'span',
          {
            class: 'swatch',
            style: { background: styleByKind('Flow').fill, border: `1px solid ${styleByKind('Flow').stroke}` }
          },
          []
        ),
        'Flow'
      ]),
      h('span', { class: 'item' }, [
        h(
          'span',
          {
            class: 'swatch',
            style: { background: styleByKind('Class').fill, border: `1px solid ${styleByKind('Class').stroke}` }
          },
          []
        ),
        'Class'
      ]),
      h('span', { class: 'item' }, [
        h(
          'span',
          {
            class: 'swatch',
            style: { background: styleByKind('Other').fill, border: `1px solid ${styleByKind('Other').stroke}` }
          },
          []
        ),
        'Other'
      ])
    ])
  ]);
  root.appendChild(toolbar);

  const PAD = 16; // outer padding
  const ROW = 26; // vertical step per visible row (after compression)
  const IND = 18; // indent per depth (x)
  const viewportW = (document.documentElement.clientWidth || window.innerWidth || 800) - 24;
  const W0 = Math.max(360, (root.clientWidth || viewportW) - PAD * 2);
  const width = W0; // overall width used by depth=0; inner boxes shrink by depth*IND*2

  // Build visibility map to compress hidden method-only regions and keep nested units visible
  type UnitFrame = Nested & { kind: 'unit' };
  type MethodFrame = Nested & { kind: 'method' };
  const unitFrames = frames.filter(f => f.kind === 'unit') as UnitFrame[];
  const methodFrames = frames.filter(f => f.kind === 'method') as MethodFrame[];

  // Map actor -> list of collapsed unit intervals [start, end)
  const collapsedByActor = new Map<string, Array<{ start: number; end: number }>>();
  for (const u of unitFrames) {
    const id = unitId(u);
    if (collapsedUnits.has(id)) {
      const arr = collapsedByActor.get(u.actor) || [];
      arr.push({ start: u.start, end: u.end ?? u.start + 1 });
      collapsedByActor.set(u.actor, arr);
    }
  }

  function methodVisible(m: MethodFrame): boolean {
    const list = collapsedByActor.get(m.actor);
    if (!list || list.length === 0) return true;
    const mStart = m.start;
    const mEnd = m.end ?? m.start + 1;
    for (const it of list) {
      if (it.start <= mStart && mEnd <= it.end) return false; // fully within a collapsed unit of same actor
    }
    return true;
  }

  const maxEnd = Math.max(...frames.map(f => f.end ?? f.start + 1));
  const keep = new Array<boolean>(Math.max(0, maxEnd)).fill(false);

  // Units contribute visibility: collapsed units keep only the header row; expanded keep full span
  for (const u of unitFrames) {
    const uStart = u.start;
    const uEnd = u.end ?? u.start + 1;
    const isCollapsed = collapsedUnits.has(unitId(u));
    if (isCollapsed) {
      if (uStart >= 0 && uStart < keep.length) keep[uStart] = true; // header row only
    } else {
      for (let t = uStart; t < uEnd; t++) keep[t] = true;
    }
  }

  // Methods contribute visibility only if not hidden by a collapsed unit of the same actor
  for (const m of methodFrames) {
    if (!methodVisible(m)) continue;
    const mStart = m.start;
    const mEnd = m.end ?? m.start + 1;
    for (let t = mStart; t < mEnd; t++) keep[t] = true;
  }

  // Build compressed row index map t -> visibleRowIndex (or -1 if hidden)
  const rowIndexByT = new Array<number>(keep.length).fill(-1);
  let rowCount = 0;
  for (let t = 0; t < keep.length; t++) {
    if (keep[t]) rowIndexByT[t] = rowCount++;
  }

  function yTopAt(t: number): number {
    const idx = rowIndexByT[t];
    const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
    return PAD + safe * ROW + 3;
  }
  function lastVisibleRowIn(start: number, endExclusive: number): number {
    for (let t = Math.min(endExclusive - 1, rowIndexByT.length - 1); t >= start; t--) {
      const idx = rowIndexByT[t];
      if (typeof idx === 'number' && idx !== -1) return idx;
    }
    const fallback = rowIndexByT[start];
    return typeof fallback === 'number' ? fallback : -1;
  }
  function yBottomAt(start: number, endExclusive: number): number {
    const lastRow = lastVisibleRowIn(start, endExclusive);
    const nextRow = (lastRow ?? 0) + 1;
    return PAD + nextRow * ROW - 3;
  }

  const totalH = PAD + rowCount * ROW + PAD;

  const svgW = width + PAD * 2 + 12; // right-side breathing room
  const svgH = totalH + 12; // bottom breathing room
  const svg = h('svg', { width: svgW, height: svgH, viewBox: `0 0 ${svgW} ${svgH}` }) as SVGSVGElement;

  // Draw frames with simple collapse support
  frames.sort((a, b) => a.start - b.start || a.depth - b.depth);

  for (const fr of frames) {
    const x = PAD + fr.depth * IND;
    const w = Math.max(40, width - fr.depth * IND * 2);
    const y1 = yTopAt(fr.start);
    const y2 = yBottomAt(fr.start, fr.end ?? fr.start + 1);
    const rectH = Math.max(14, y2 - y1);

    if (fr.kind === 'unit') {
      const id = unitId(fr);
      const collapsed = collapsedUnits.has(id);
      const sty = styleByKind(kindFromActor(fr.actor));
      const hasMethods = methodActorSet.has(fr.actor);
      const g = h(
        'g',
        {
          class: 'unit',
          style: hasMethods ? { cursor: 'pointer' } : undefined,
          onclick: hasMethods
            ? () => {
                if (collapsedUnits.has(id)) collapsedUnits.delete(id);
                else collapsedUnits.add(id);
                if (currentGraph) render(currentGraph);
              }
            : undefined
        },
        []
      );
      // For collapsed units, render a minimal height box tied to the header row
      const unitRectH = collapsed ? Math.max(14, ROW - 6) : rectH;
      g.appendChild(
        h('rect', {
          x,
          y: y1,
          width: w,
          height: unitRectH,
          rx: 8,
          ry: 8,
          fill: sty.fill,
          stroke: sty.stroke,
          'stroke-width': 1.6
        })
      );
      const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
      const prefix = hasMethods ? (collapsed ? '▸ ' : '▾ ') : '';
      const label = prefix + truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix;
      g.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
      g.appendChild(h('title', {}, [sanitizeText(fr.label)]));
      svg.appendChild(g);
    } else {
      // Draw method only if visible (not fully within a collapsed unit of the same actor)
      const visible = (() => {
        const m = fr as MethodFrame;
        return methodVisible(m);
      })();
      if (visible) {
        const sty = styleByKind(kindFromActor(fr.actor));
        const g = h('g');
        g.appendChild(
          h('rect', {
            x,
            y: y1,
            width: w,
            height: rectH,
            rx: 8,
            ry: 8,
            fill: sty.fill,
            stroke: sty.stroke,
            'stroke-width': 1
          })
        );
        const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
        const label = truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix;
        g.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
        g.appendChild(h('title', {}, [sanitizeText(fr.label)]));
        svg.appendChild(g);
      }
    }
  }

  const scroller = h(
    'div',
    {
      style: {
        position: 'absolute',
        top: '36px',
        left: '0',
        right: '0',
        bottom: '0',
        overflowY: 'auto',
        overflowX: 'auto'
      }
    },
    [svg]
  );
  root.appendChild(scroller);
}

window.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'graph') render(msg.graph || { nodes: [], sequence: [], nested: [] });
});

document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
