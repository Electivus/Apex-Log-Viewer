/* Simple left-to-right flow diagram (no external libs). */
declare function acquireVsCodeApi(): any;

type Nested = {
  actor: string;
  label: string;
  start: number;
  end?: number;
  depth: number;
  kind: 'unit' | 'method';
  profile?: { soql?: number; dml?: number; callout?: number; cpuMs?: number; heapBytes?: number };
};
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

function humanBytes(n?: number): string {
  if (!n || n <= 0) return '0 B';
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
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
let showProfilingChips = false;
let showProfilingSidebar = true;
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
      // Sum profiling counters when collapsing repeats
      if (f.profile) {
        (prev.profile ||= {} as any);
        if (f.profile.soql) (prev.profile as any).soql = ((prev.profile as any).soql || 0) + f.profile.soql;
        if (f.profile.dml) (prev.profile as any).dml = ((prev.profile as any).dml || 0) + f.profile.dml;
        if (f.profile.callout)
          (prev.profile as any).callout = ((prev.profile as any).callout || 0) + f.profile.callout;
        if (f.profile.cpuMs) (prev.profile as any).cpuMs = ((prev.profile as any).cpuMs || 0) + f.profile.cpuMs;
        if (f.profile.heapBytes)
          (prev.profile as any).heapBytes = ((prev.profile as any).heapBytes || 0) + f.profile.heapBytes;
      }
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

function formatStats(fr: Nested | undefined): string {
  if (!fr || !fr.profile) return '';
  const parts: string[] = [];
  const p = fr.profile || {};
  if (p.soql && p.soql > 0) parts.push(`S${p.soql}`);
  if (p.dml && p.dml > 0) parts.push(`D${p.dml}`);
  if (p.callout && p.callout > 0) parts.push(`C${p.callout}`);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

function tooltipFor(fr: Nested): string {
  const lines: string[] = [];
  lines.push(sanitizeText(fr.label));
  const p = fr.profile || {};
  const counters: string[] = [];
  if (p.soql) counters.push(`SOQL: ${p.soql}`);
  if (p.dml) counters.push(`DML: ${p.dml}`);
  if (p.callout) counters.push(`Callouts: ${p.callout}`);
  if (counters.length) lines.push(counters.join(', '));
  const perf: string[] = [];
  if (p.cpuMs) perf.push(`CPU: ${p.cpuMs} ms`);
  if (p.heapBytes) perf.push(`Heap: ${humanBytes(p.heapBytes)}`);
  if (perf.length) lines.push(perf.join(', '));
  return lines.join('\n');
}

function chipTextFor(fr: Nested): string | undefined {
  const p = fr.profile || {};
  const cpu = p.cpuMs && p.cpuMs > 0 ? `CPU ${p.cpuMs}ms` : '';
  const heap = p.heapBytes && p.heapBytes > 0 ? `Heap ${humanBytes(p.heapBytes)}` : '';
  const both = [cpu, heap].filter(Boolean).join(' • ');
  return both || undefined;
}

function estimateChipWidth(text: string, fontSize = 11): number {
  const avg = fontSize * 0.62; // rough average glyph width
  const padding = 10; // inner padding
  return Math.max(28, Math.round(text.length * avg) + padding);
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
  // Initialize with all units expanded by default. On subsequent renders, keep only ids that still exist.
  if (!collapseInitialized) {
    collapsedUnits = new Set();
    collapseInitialized = true;
  } else {
    collapsedUnits = new Set(unitIds.filter(id => collapsedUnits.has(id)));
  }

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
    h('label', {}, [
      h(
        'input',
        {
          type: 'checkbox',
          checked: showProfilingChips ? 'checked' : undefined,
          onchange: (e: any) => {
            showProfilingChips = !!e.target.checked;
            if (currentGraph) render(currentGraph);
          }
        },
        []
      ),
      ' Show profiling'
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
      ]),
      h('span', { class: 'item', style: { opacity: 0.9 } as any }, ['· S: SOQL']),
      h('span', { class: 'item', style: { opacity: 0.9 } as any }, ['· D: DML']),
      h('span', { class: 'item', style: { opacity: 0.9 } as any }, ['· C: Callout'])
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

  // Collect collapsed unit intervals [start, end) regardless of actor
  const collapsedIntervals: Array<{ start: number; end: number }> = [];
  for (const u of unitFrames) {
    const id = unitId(u);
    if (collapsedUnits.has(id)) {
      collapsedIntervals.push({ start: u.start, end: u.end ?? u.start + 1 });
    }
  }

  function methodVisible(m: MethodFrame): boolean {
    if (collapsedIntervals.length === 0) return true;
    const mStart = m.start;
    const mEnd = m.end ?? m.start + 1;
    for (const it of collapsedIntervals) {
      if (it.start <= mStart && mEnd <= it.end) return false; // fully within any collapsed unit span
    }
    return true;
  }

  const maxEnd = Math.max(...frames.map(f => f.end ?? f.start + 1));
  const keep = new Array<boolean>(Math.max(0, maxEnd)).fill(false);

  // Helper: whether a span is fully inside any collapsed unit interval
  function withinCollapsed(start: number, endExclusive: number): boolean {
    for (const it of collapsedIntervals) {
      if (it.start <= start && endExclusive <= it.end) return true;
    }
    return false;
  }

  // Units contribute visibility: collapsed units OR units inside a collapsed parent keep only header row; expanded keep full span
  for (const u of unitFrames) {
    const uStart = u.start;
    const uEnd = u.end ?? u.start + 1;
    const isCollapsed = collapsedUnits.has(unitId(u));
    const forcedMinimal = withinCollapsed(uStart, uEnd);
    if (isCollapsed || forcedMinimal) {
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
      const stats = formatStats(fr);
      const label = prefix + truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix + stats;
      g.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
      g.appendChild(h('title', {}, [tooltipFor(fr)]));
      // Profiling chip
      if (showProfilingChips) {
        const chip = chipTextFor(fr);
        if (chip) {
          const ch = 16;
          const cw = estimateChipWidth(chip, 11);
          const cy = y1 + 4;
          const cx = x + w - cw - 8;
          g.appendChild(
            h('rect', {
              x: cx,
              y: cy,
              width: cw,
              height: ch,
              rx: 8,
              ry: 8,
              fill: 'rgba(148,163,184,0.18)',
              stroke: 'rgba(148,163,184,0.45)',
              'stroke-width': 1
            })
          );
          g.appendChild(h('text', { x: cx + 6, y: cy + 12, fill: 'var(--vscode-descriptionForeground)', 'font-size': 11 }, [chip]));
        }
      }
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
        const stats = formatStats(fr);
        const label = truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix + stats;
        g.appendChild(h('text', { x: x + 10, y: y1 + 16, fill: 'var(--vscode-foreground)', 'font-size': 12 }, [label]));
        g.appendChild(h('title', {}, [tooltipFor(fr)]));
        if (showProfilingChips) {
          const chip = chipTextFor(fr);
          if (chip) {
            const ch = 16;
            const cw = estimateChipWidth(chip, 11);
            const cy = y1 + 4;
            const cx = x + w - cw - 8;
            g.appendChild(
              h('rect', {
                x: cx,
                y: cy,
                width: cw,
                height: ch,
                rx: 8,
                ry: 8,
                fill: 'rgba(148,163,184,0.18)',
                stroke: 'rgba(148,163,184,0.45)',
                'stroke-width': 1
              })
            );
            g.appendChild(
              h('text', { x: cx + 6, y: cy + 12, fill: 'var(--vscode-descriptionForeground)', 'font-size': 11 }, [chip])
            );
          }
        }
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
