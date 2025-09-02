import React from 'react';
import type { DiagramNestedWithCount } from '../../../shared/diagramTypes';
import { useDiagramData } from '../../hooks/useDiagramData';

type DiagramFrameProps = {
  frame: DiagramNestedWithCount;
  x: number;
  y: number;
  width: number;
  height: number;
  isCollapsed?: boolean;
  hasChildren?: boolean;
  onToggle?: () => void;
};

export function DiagramFrame({
  frame,
  x,
  y,
  width,
  height,
  isCollapsed = false,
  hasChildren = false,
  onToggle
}: DiagramFrameProps) {
  const { utils } = useDiagramData();

  const style = utils.styleByKind(utils.kindFromActor(frame.actor));
  const countSuffix = frame.count && frame.count > 1 ? ` ×${frame.count}` : '';
  const prefix = hasChildren ? (isCollapsed ? '▸ ' : '▾ ') : '';
  const label = prefix + utils.truncate(frame.label.replace(/^Class\./, ''), 80) + countSuffix;
  const sanitizedLabel = utils.sanitizeText(frame.label);

  const rectHeight = isCollapsed && frame.kind === 'unit' ? Math.max(14, 20) : height;

  return (
    <g
      className={frame.kind}
      style={hasChildren ? { cursor: 'pointer' } : undefined}
      onClick={hasChildren ? onToggle : undefined}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={rectHeight}
        rx={8}
        ry={8}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={frame.kind === 'unit' ? 1.6 : 1}
      />
      <text x={x + 10} y={y + 16} fill="var(--vscode-foreground)" fontSize={12}>
        {label}
      </text>
      <title>{sanitizedLabel}</title>
    </g>
  );
}
