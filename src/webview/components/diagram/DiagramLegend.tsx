import React from 'react';
import type { DiagramKind } from '../../../shared/diagramTypes';
import { useDiagramData } from '../../hooks/useDiagramData';

type DiagramLegendProps = {
  className?: string;
};

export function DiagramLegend({ className }: DiagramLegendProps) {
  const { utils } = useDiagramData();

  const legendItems: { kind: DiagramKind; label: string }[] = [
    { kind: 'Trigger', label: 'Trigger' },
    { kind: 'Flow', label: 'Flow' },
    { kind: 'Class', label: 'Class' },
    { kind: 'Other', label: 'Other' }
  ];

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        marginLeft: 'auto',
        opacity: 0.9,
        fontSize: 12
      }}
    >
      {legendItems.map(({ kind, label }) => {
        const style = utils.styleByKind(kind);
        return (
          <div
            key={kind}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                display: 'inline-block',
                background: style.fill,
                border: `1px solid ${style.stroke}`
              }}
            />
            {label}
          </div>
        );
      })}
    </div>
  );
}
