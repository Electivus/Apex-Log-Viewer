import React, { useMemo } from 'react';

export type Nested = { actor: string; label: string; start: number; end?: number; depth: number; kind: 'unit' | 'method' };

export interface DiagramCanvasProps {
  frames: Nested[];
  styleByKind: (k: 'Trigger' | 'Flow' | 'Class' | 'Other') => { stroke: string; fill: string };
  methodActorSet: Set<string>;
  collapsedUnits: Set<string>;
  onToggleUnit: (unitId: string) => void;
}

function unitId(fr: Nested): string {
  return `${fr.actor}:${fr.start}`;
}

function kindFromActor(actor: string): 'Trigger' | 'Flow' | 'Class' | 'Other' {
  if (actor.startsWith('Trigger:')) return 'Trigger';
  if (actor.startsWith('Flow:')) return 'Flow';
  if (actor.startsWith('Class:')) return 'Class';
  return 'Other';
}

function truncate(s: string, max = 80): string {
  return s && s.length > max ? s.slice(0, max - 1) + '…' : s || '';
}

function sanitizeText(s: string): string {
  if (!s) return '';
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function DiagramCanvas(props: DiagramCanvasProps) {
  const { frames, styleByKind, methodActorSet, collapsedUnits, onToggleUnit } = props;

  const PAD = 16;
  const ROW = 26;
  const IND = 18;

  const {
    svgWidth,
    svgHeight,
    rowIndexByT,
    maxRowCount,
    collapsedIntervals
  } = useMemo(() => {
    // Collect collapsed unit intervals [start, end)
    const unitFrames = frames.filter(f => f.kind === 'unit');
    const methodFrames = frames.filter(f => f.kind === 'method');
    const intervals: Array<{ start: number; end: number }> = [];
    for (const u of unitFrames) {
      const id = unitId(u);
      if (collapsedUnits.has(id)) {
        intervals.push({ start: u.start, end: u.end ?? u.start + 1 });
      }
    }

    function methodVisible(start: number, endExclusive: number): boolean {
      if (intervals.length === 0) return true;
      for (const it of intervals) {
        if (it.start <= start && endExclusive <= it.end) return false;
      }
      return true;
    }

    const maxEnd = Math.max(...frames.map(f => f.end ?? f.start + 1));
    const keep = new Array<boolean>(Math.max(0, maxEnd)).fill(false);

    function withinCollapsed(start: number, endExclusive: number): boolean {
      for (const it of intervals) {
        if (it.start <= start && endExclusive <= it.end) return true;
      }
      return false;
    }

    for (const u of unitFrames) {
      const uStart = u.start;
      const uEnd = u.end ?? u.start + 1;
      const isCollapsed = collapsedUnits.has(unitId(u));
      const forcedMinimal = withinCollapsed(uStart, uEnd);
      if (isCollapsed || forcedMinimal) {
        if (uStart >= 0 && uStart < keep.length) keep[uStart] = true;
      } else {
        for (let t = uStart; t < uEnd; t++) keep[t] = true;
      }
    }

    for (const m of methodFrames) {
      const mStart = m.start;
      const mEnd = m.end ?? m.start + 1;
      if (!methodVisible(mStart, mEnd)) continue;
      for (let t = mStart; t < mEnd; t++) keep[t] = true;
    }

    const rowIndexByT = new Array<number>(keep.length).fill(-1);
    let rowCount = 0;
    for (let t = 0; t < keep.length; t++) {
      if (keep[t]) rowIndexByT[t] = rowCount++;
    }

    const totalH = PAD + rowCount * ROW + PAD;
    const viewportW = (document.documentElement.clientWidth || window.innerWidth || 800) - 24;
    const W0 = Math.max(360, viewportW - PAD * 2);
    const svgW = W0 + PAD * 2 + 12;
    const svgH = totalH + 12;

    return {
      svgWidth: svgW,
      svgHeight: svgH,
      rowIndexByT,
      maxRowCount: rowCount,
      collapsedIntervals: intervals
    };
  }, [frames, collapsedUnits]);

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

  const width = useMemo(() => {
    const viewportW = (document.documentElement.clientWidth || window.innerWidth || 800) - 24;
    const W0 = Math.max(360, viewportW - PAD * 2);
    return W0;
  }, []);

  const sortedFrames = useMemo(() => frames.slice().sort((a, b) => a.start - b.start || a.depth - b.depth), [frames]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 36,
        left: 0,
        right: 0,
        bottom: 0,
        overflowY: 'auto',
        overflowX: 'auto'
      }}
    >
      <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
        {sortedFrames.map(fr => {
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
            const unitRectH = collapsed ? Math.max(14, ROW - 6) : rectH;
            const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
            const prefix = hasMethods ? (collapsed ? '▸ ' : '▾ ') : '';
            const label = prefix + truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix;
            return (
              <g
                key={`${fr.actor}-${fr.start}-u`}
                className="unit"
                style={hasMethods ? { cursor: 'pointer' } : undefined}
                onClick={hasMethods ? () => onToggleUnit(id) : undefined}
              >
                <rect
                  x={x}
                  y={y1}
                  width={w}
                  height={unitRectH}
                  rx={8}
                  ry={8}
                  fill={sty.fill}
                  stroke={sty.stroke}
                  strokeWidth={1.6}
                />
                <text x={x + 10} y={y1 + 16} fill={'var(--vscode-foreground)'} fontSize={12}>
                  {label}
                </text>
                <title>{sanitizeText(fr.label)}</title>
              </g>
            );
          } else {
            // Only render method if not fully within a collapsed unit interval
            const mStart = fr.start;
            const mEnd = fr.end ?? fr.start + 1;
            const visible = !collapsedIntervals.some(it => it.start <= mStart && mEnd <= it.end);
            if (!visible) return null;
            const sty = styleByKind(kindFromActor(fr.actor));
            const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
            const label = truncate(fr.label.replace(/^Class\./, ''), 80) + countSuffix;
            return (
              <g key={`${fr.actor}-${fr.start}-m`}>
                <rect x={x} y={y1} width={w} height={rectH} rx={8} ry={8} fill={sty.fill} stroke={sty.stroke} strokeWidth={1} />
                <text x={x + 10} y={y1 + 16} fill={'var(--vscode-foreground)'} fontSize={12}>
                  {label}
                </text>
                <title>{sanitizeText(fr.label)}</title>
              </g>
            );
          }
        })}
      </svg>
    </div>
  );
}

