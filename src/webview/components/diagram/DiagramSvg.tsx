import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { NestedFrame } from '../../../shared/apexLogParser';

type UnitFrame = NestedFrame & { kind: 'unit'; count?: number };
type MethodFrame = NestedFrame & { kind: 'method'; count?: number };

function truncate(s: string, max = 80): string {
  return s && s.length > max ? s.slice(0, max - 1) + '…' : s || '';
}

function unitId(fr: NestedFrame): string {
  return `${fr.actor}:${fr.start}`;
}

type Kind = 'Trigger' | 'Flow' | 'Class' | 'Other';
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

export function DiagramSvg({
  frames,
  collapsedUnits,
  onToggleUnit
}: {
  frames: (NestedFrame & { count?: number })[];
  collapsedUnits: Set<string>;
  onToggleUnit: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);

  // Measure container width (resizes)
  useEffect(() => {
    const measure = () => setContainerWidth(containerRef.current?.clientWidth || 800);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Constants
  const PAD = 16; // outer padding
  const ROW = 26; // vertical step per visible row (after compression)
  const IND = 18; // indent per depth (x)
  const width = Math.max(360, containerWidth - PAD * 2);

  const methodActorSet = useMemo(() => {
    const s = new Set<string>();
    for (const fr of frames) if (fr.kind === 'method') s.add(fr.actor);
    return s;
  }, [frames]);

  const unitFrames = useMemo(() => frames.filter(f => f.kind === 'unit') as UnitFrame[], [frames]);
  const methodFrames = useMemo(() => frames.filter(f => f.kind === 'method') as MethodFrame[], [frames]);

  const collapsedIntervals = useMemo(() => {
    const arr: Array<{ start: number; end: number }> = [];
    for (const u of unitFrames) {
      if (collapsedUnits.has(unitId(u))) arr.push({ start: u.start, end: u.end ?? u.start + 1 });
    }
    return arr;
  }, [unitFrames, collapsedUnits]);

  const methodVisible = (m: MethodFrame): boolean => {
    if (collapsedIntervals.length === 0) return true;
    const mStart = m.start;
    const mEnd = m.end ?? m.start + 1;
    for (const it of collapsedIntervals) {
      if (it.start <= mStart && mEnd <= it.end) return false;
    }
    return true;
  };

  const maxEnd = useMemo(() => (frames.length ? Math.max(...frames.map(f => f.end ?? f.start + 1)) : 0), [frames]);
  const keep = useMemo(() => {
    const k = new Array<boolean>(Math.max(0, maxEnd)).fill(false);
    const withinCollapsed = (start: number, endExclusive: number): boolean => {
      for (const it of collapsedIntervals) if (it.start <= start && endExclusive <= it.end) return true;
      return false;
    };
    for (const u of unitFrames) {
      const uStart = u.start;
      const uEnd = u.end ?? u.start + 1;
      const isCollapsed = collapsedUnits.has(unitId(u));
      const forcedMinimal = withinCollapsed(uStart, uEnd);
      if (isCollapsed || forcedMinimal) {
        if (uStart >= 0 && uStart < k.length) k[uStart] = true; // header
      } else {
        for (let t = uStart; t < uEnd; t++) k[t] = true;
      }
    }
    for (const m of methodFrames) {
      if (!methodVisible(m)) continue;
      const mStart = m.start;
      const mEnd = m.end ?? m.start + 1;
      for (let t = mStart; t < mEnd; t++) k[t] = true;
    }
    return k;
  }, [maxEnd, collapsedIntervals, unitFrames, methodFrames, collapsedUnits]);

  const rowIndexByT = useMemo(() => {
    const arr = new Array<number>(keep.length).fill(-1);
    let row = 0;
    for (let t = 0; t < keep.length; t++) if (keep[t]) arr[t] = row++;
    return arr;
  }, [keep]);

  const yTopAt = (t: number): number => {
    const idx = rowIndexByT[t];
    const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
    return PAD + safe * ROW + 3;
  };
  const lastVisibleRowIn = (start: number, endExclusive: number): number => {
    for (let t = Math.min(endExclusive - 1, rowIndexByT.length - 1); t >= start; t--) {
      const idx = rowIndexByT[t];
      if (typeof idx === 'number' && idx !== -1) return idx;
    }
    const fallback = rowIndexByT[start];
    return typeof fallback === 'number' ? fallback : -1;
  };
  const yBottomAt = (start: number, endExclusive: number): number => {
    const lastRow = lastVisibleRowIn(start, endExclusive);
    const nextRow = (lastRow ?? 0) + 1;
    return PAD + nextRow * ROW - 3;
  };

  const rowCount = useMemo(() => rowIndexByT.reduce((m, v) => (v >= 0 ? Math.max(m, v + 1) : m), 0), [rowIndexByT]);
  const totalH = PAD + rowCount * ROW + PAD;

  const svgW = width + PAD * 2 + 12;
  const svgH = totalH + 12;

  const framesSorted = useMemo(() => frames.slice().sort((a, b) => a.start - b.start || a.depth - b.depth), [frames]);

  return (
    <div ref={containerRef}>
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
        {framesSorted.map(fr => {
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
            const label = prefix + truncate(fr.label.replace(/^Class\./, '')) + countSuffix;
            const textColor = 'var(--vscode-foreground)';
            return (
              <g
                key={`u-${fr.actor}-${fr.start}`}
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
                <text x={x + 10} y={y1 + 16} fill={textColor} fontSize={12}>
                  {label}
                </text>
                <title>{fr.label}</title>
              </g>
            );
          }

          // Method
          const visible = (() => {
            const m = fr as MethodFrame;
            return methodVisible(m);
          })();
          if (!visible) return null;
          const sty = styleByKind(kindFromActor(fr.actor));
          const countSuffix = (fr as any).count && (fr as any).count > 1 ? ` ×${(fr as any).count}` : '';
          const label = truncate(fr.label.replace(/^Class\./, '')) + countSuffix;
          const textColor = 'var(--vscode-foreground)';
          return (
            <g key={`m-${fr.actor}-${fr.start}`}>
              <rect x={x} y={y1} width={w} height={rectH} rx={8} ry={8} fill={sty.fill} stroke={sty.stroke} strokeWidth={1} />
              <text x={x + 10} y={y1 + 16} fill={textColor} fontSize={12}>
                {label}
              </text>
              <title>{fr.label}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

