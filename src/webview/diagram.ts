/* eslint-disable @typescript-eslint/no-explicit-any */
import * as d3 from 'd3';

declare function acquireVsCodeApi(): any;

type Graph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  flow: { actor: string; label: string; start: number; end?: number; depth: number; kind: 'unit'|'method' }[];
};

const vscode = acquireVsCodeApi();

function truncate(s: string, max = 60): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function render(graph: Graph) {
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  const wrap = d3
    .select(root)
    .append('div')
    .style('position', 'relative')
    .style('width', '100%')
    .style('height', '100%')
    .style('overflow', 'hidden');

  const margin = { top: 56, right: 32, bottom: 24, left: 32 };
  const row = 36;
  const actorsOrder = new Map<string, number>();
  const nodesById = new Map(graph.nodes.map(n => [n.id, n] as const));
  function see(id?: string) {
    if (!id) return;
    if (!actorsOrder.has(id)) actorsOrder.set(id, actorsOrder.size);
  }
  for (const ev of graph.sequence || []) {
    see(ev.from);
    see(ev.to);
  }
  const actors = Array.from(actorsOrder.keys());
  const width = (root.clientWidth || 800);
  const height = Math.max(240, margin.top + (graph.sequence?.length || 0) * row + margin.bottom);

  // Main SVG with zoom/pan
  const svg = wrap
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .style('background', 'transparent')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const defs = svg.append('defs');
  defs
    .append('marker')
    .attr('id', 'arrow')
    .attr('markerWidth', 8)
    .attr('markerHeight', 6)
    .attr('refX', 8)
    .attr('refY', 3)
    .attr('orient', 'auto')
    .attr('markerUnits', 'strokeWidth')
    .append('path')
    .attr('d', 'M0,0 L8,3 L0,6 z')
    .attr('fill', 'var(--vscode-editor-foreground, #888)');

  const g = svg.append('g');

  const band = d3
    .scaleBand<string>()
    .domain(actors)
    .range([margin.left, Math.max(margin.left + 1, width - margin.right)])
    .paddingInner(0.2)
    .paddingOuter(0.1);

  const header = g.append('g');
  const headers = header
    .selectAll('g.actor')
    .data(actors, d => String(d))
    .join(enter => {
      const grp = enter
        .append('g')
        .attr('class', 'actor')
        .attr('transform', d => `translate(${(band(d) || 0)},0)`);
      grp
        .append('rect')
        .attr('x', 0)
        .attr('y', 8)
        .attr('rx', 6)
        .attr('ry', 6)
        .attr('width', Math.max(40, band.bandwidth()))
        .attr('height', 32)
        .attr('fill', 'var(--vscode-editorWidget-background, rgba(127,127,127,0.15))')
        .attr('stroke', 'var(--vscode-editorWidget-border, rgba(127,127,127,0.35))')
        .attr('stroke-width', 1);
      grp
        .append('text')
        .attr('x', Math.max(40, band.bandwidth()) / 2)
        .attr('y', 28)
        .attr('text-anchor', 'middle')
        .attr('fill', 'var(--vscode-foreground)')
        .attr('font-weight', 600)
        .attr('font-size', 12)
        .text(d => truncate(nodesById.get(d)?.label || d.split(':').slice(1).join(':'), 28));
      return grp;
    });

  // Lifelines
  g
    .append('g')
    .attr('class', 'lifelines')
    .selectAll('line')
    .data(actors, d => String(d))
    .join('line')
    .attr('x1', d => (band(d) || 0) + band.bandwidth() / 2)
    .attr('x2', d => (band(d) || 0) + band.bandwidth() / 2)
    .attr('y1', margin.top)
    .attr('y2', height - 16)
    .attr('stroke', 'var(--vscode-editor-foreground, #888)')
    .attr('stroke-dasharray', '4 4')
    .attr('opacity', 0.6);

  // Flow spans (nested boxes por ator)
  const spansG = g.append('g').attr('class', 'spans');
  const lanePad = 6;
  const indent = 8;
  (graph.flow || []).forEach(span => {
    const laneX = band(span.actor) || 0;
    const bw = band.bandwidth();
    const x = laneX + lanePad + span.depth * indent;
    const w = Math.max(16, bw - 2 * lanePad - span.depth * indent * 2);
    const y1 = margin.top + span.start * row + 4;
    const y2 = margin.top + (span.end ?? span.start + 1) * row - 4;
    const h = Math.max(10, y2 - y1);
    spansG
      .append('rect')
      .attr('x', x)
      .attr('y', y1)
      .attr('width', w)
      .attr('height', h)
      .attr('rx', 4)
      .attr('ry', 4)
      .attr('fill', 'var(--vscode-editorWidget-background, rgba(127,127,127,0.15))')
      .attr('stroke', span.kind === 'unit' ? 'var(--vscode-foreground, #ccc)' : 'var(--vscode-editorWidget-border, rgba(127,127,127,0.35))')
      .attr('stroke-width', span.kind === 'unit' ? 1.5 : 1);
    spansG
      .append('text')
      .attr('x', x + 6)
      .attr('y', y1 + 14)
      .attr('fill', 'var(--vscode-foreground)')
      .attr('font-size', 11)
      .text(truncate(span.label.replace(/^Class\./, ''), 68));
  });

  // Pequenas setas somente para transições de unidade (ajuda a ver troca de trigger/flow)
  const eventsG = g.append('g').attr('class', 'events');
  (graph.sequence || []).forEach((ev, i) => {
    if (!ev.from) return;
    const isUnit = (graph.flow || []).some(s => s.kind === 'unit' && s.start === i && s.actor === ev.to);
    if (!isUnit) return;
    const y = margin.top + i * row + row / 2;
    const x1 = (band(ev.from) || 0) + band.bandwidth() / 2;
    const x2 = (band(ev.to) || 0) + band.bandwidth() / 2;
    eventsG
      .append('line')
      .attr('x1', x1)
      .attr('y1', y)
      .attr('x2', x2)
      .attr('y2', y)
      .attr('stroke', 'var(--vscode-editor-foreground, #888)')
      .attr('stroke-width', 1)
      .attr('marker-end', 'url(#arrow)')
      .attr('opacity', 0.7);
  });

  // Zoom/pan
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.5, 3])
    .on('zoom', (ev) => {
      g.attr('transform', String(ev.transform));
    });
  svg.call(zoom as any);
}

window.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'graph') {
    render(msg.graph || { nodes: [], sequence: [], flow: [] });
  }
});

document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
