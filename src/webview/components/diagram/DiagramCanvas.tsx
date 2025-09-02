import React, { useMemo } from 'react';
import type { DiagramNestedWithCount, DiagramState } from '../../../shared/diagramTypes';
import { DiagramFrame } from './DiagramFrame';
import { useDiagramData } from '../../hooks/useDiagramData';

type DiagramCanvasProps = {
  frames: DiagramNestedWithCount[];
  state: DiagramState;
  onToggleUnit: (unitId: string) => void;
};

const PAD = 16; // outer padding
const ROW = 26; // vertical step per visible row (after compression)
const IND = 18; // indent per depth (x)

export function DiagramCanvas({ frames, state, onToggleUnit }: DiagramCanvasProps) {
  const { utils } = useDiagramData();

  const { visibleFrames, rowIndexByT, totalHeight, canvasWidth } = useMemo(() => {
    const unitFrames = frames.filter(f => f.kind === 'unit');
    const methodFrames = frames.filter(f => f.kind === 'method');
    const methodActorSet = new Set<string>();
    for (const fr of frames) if (fr.kind === 'method') methodActorSet.add(fr.actor);

    // Calculate viewport dimensions
    const viewportW = (document.documentElement.clientWidth || window.innerWidth || 800) - 24;
    const width = Math.max(360, viewportW - PAD * 2);

    // Build collapsed intervals
    const collapsedIntervals: Array<{ start: number; end: number }> = [];
    for (const unit of unitFrames) {
      const id = utils.unitId(unit);
      if (state.collapsedUnits.has(id)) {
        collapsedIntervals.push({ start: unit.start, end: unit.end ?? unit.start + 1 });
      }
    }

    // Determine method visibility
    function methodVisible(method: (typeof methodFrames)[0]): boolean {
      if (collapsedIntervals.length === 0) return true;
      const mStart = method.start;
      const mEnd = method.end ?? method.start + 1;
      for (const interval of collapsedIntervals) {
        if (interval.start <= mStart && mEnd <= interval.end) return false;
      }
      return true;
    }

    // Build visibility map
    const maxEnd = Math.max(...frames.map(f => f.end ?? f.start + 1));
    const keep = new Array<boolean>(Math.max(0, maxEnd)).fill(false);

    // Helper: whether a span is fully inside any collapsed unit interval
    function withinCollapsed(start: number, endExclusive: number): boolean {
      for (const interval of collapsedIntervals) {
        if (interval.start <= start && endExclusive <= interval.end) return true;
      }
      return false;
    }

    // Units contribute visibility
    for (const unit of unitFrames) {
      const uStart = unit.start;
      const uEnd = unit.end ?? unit.start + 1;
      const isCollapsed = state.collapsedUnits.has(utils.unitId(unit));
      const forcedMinimal = withinCollapsed(uStart, uEnd);
      if (isCollapsed || forcedMinimal) {
        if (uStart >= 0 && uStart < keep.length) keep[uStart] = true; // header row only
      } else {
        for (let t = uStart; t < uEnd; t++) keep[t] = true;
      }
    }

    // Methods contribute visibility
    for (const method of methodFrames) {
      if (!methodVisible(method)) continue;
      const mStart = method.start;
      const mEnd = method.end ?? method.start + 1;
      for (let t = mStart; t < mEnd; t++) keep[t] = true;
    }

    // Build compressed row index map
    const rowMap = new Array<number>(keep.length).fill(-1);
    let rowCount = 0;
    for (let t = 0; t < keep.length; t++) {
      if (keep[t]) rowMap[t] = rowCount++;
    }

    // Helper functions for positioning
    function yTopAt(t: number): number {
      const idx = rowMap[t];
      const safe = typeof idx === 'number' && idx >= 0 ? idx : 0;
      return PAD + safe * ROW + 3;
    }

    function lastVisibleRowIn(start: number, endExclusive: number): number {
      for (let t = Math.min(endExclusive - 1, rowMap.length - 1); t >= start; t--) {
        const idx = rowMap[t];
        if (typeof idx === 'number' && idx !== -1) return idx;
      }
      const fallback = rowMap[start];
      return typeof fallback === 'number' ? fallback : -1;
    }

    function yBottomAt(start: number, endExclusive: number): number {
      const lastRow = lastVisibleRowIn(start, endExclusive);
      const nextRow = (lastRow ?? 0) + 1;
      return PAD + nextRow * ROW - 3;
    }

    // Calculate visible frames with positioning
    const visibleFrameData = frames
      .filter(frame => {
        if (frame.kind === 'method') {
          return methodVisible(frame as any);
        }
        return true; // Units are always visible (even if collapsed)
      })
      .map(frame => {
        const x = PAD + frame.depth * IND;
        const w = Math.max(40, width - frame.depth * IND * 2);
        const y1 = yTopAt(frame.start);
        const y2 = yBottomAt(frame.start, frame.end ?? frame.start + 1);
        const rectH = Math.max(14, y2 - y1);

        return {
          frame,
          x,
          y: y1,
          width: w,
          height: rectH,
          isCollapsed: frame.kind === 'unit' ? state.collapsedUnits.has(utils.unitId(frame)) : false,
          hasChildren: frame.kind === 'unit' && methodActorSet.has(frame.actor)
        };
      });

    const totalH = PAD + rowCount * ROW + PAD;
    const canvasW = width + PAD * 2 + 12; // right-side breathing room

    return {
      visibleFrames: visibleFrameData,
      rowIndexByT: rowMap,
      totalHeight: totalH + 12, // bottom breathing room
      canvasWidth: canvasW
    };
  }, [frames, state, utils]);

  if (frames.length === 0) {
    return <div style={{ padding: '8px', opacity: 0.8 }}>No flow detected.</div>;
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: '36px',
        left: '0',
        right: '0',
        bottom: '0',
        overflowY: 'auto',
        overflowX: 'auto'
      }}
    >
      <svg width={canvasWidth} height={totalHeight} viewBox={`0 0 ${canvasWidth} ${totalHeight}`}>
        {visibleFrames.map((item, index) => (
          <DiagramFrame
            key={`${utils.unitId(item.frame)}-${index}`}
            frame={item.frame}
            x={item.x}
            y={item.y}
            width={item.width}
            height={item.height}
            isCollapsed={item.isCollapsed}
            hasChildren={item.hasChildren}
            onToggle={item.hasChildren ? () => onToggleUnit(utils.unitId(item.frame)) : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
