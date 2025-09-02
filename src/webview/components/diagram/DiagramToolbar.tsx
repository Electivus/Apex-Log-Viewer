import React from 'react';

export type Kind = 'Trigger' | 'Flow' | 'Class' | 'Other';

export interface DiagramToolbarProps {
  hideSystem: boolean;
  onToggleHideSystem: (value: boolean) => void;
  collapseRepeats: boolean;
  onToggleCollapseRepeats: (value: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  colorsByKind: Record<Kind, { stroke: string; fill: string }>;
}

export function DiagramToolbar(props: DiagramToolbarProps) {
  const {
    hideSystem,
    onToggleHideSystem,
    collapseRepeats,
    onToggleCollapseRepeats,
    onExpandAll,
    onCollapseAll,
    colorsByKind
  } = props;

  return (
    <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={hideSystem}
          onChange={e => onToggleHideSystem(!!e.target.checked)}
        />
        <span>Hide System</span>
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={collapseRepeats}
          onChange={e => onToggleCollapseRepeats(!!e.target.checked)}
        />
        <span>Collapse repeats</span>
      </label>
      <button onClick={onExpandAll} style={{ padding: '2px 8px' }}>Expand all</button>
      <button onClick={onCollapseAll} style={{ padding: '2px 8px' }}>Collapse all</button>

      <div className="legend" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto', opacity: 0.9, fontSize: 12 }}>
        {(['Trigger', 'Flow', 'Class', 'Other'] as Kind[]).map(kind => (
          <span key={kind} className="item" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              className="swatch"
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                display: 'inline-block',
                background: colorsByKind[kind].fill,
                border: `1px solid ${colorsByKind[kind].stroke}`
              }}
            />
            {kind}
          </span>
        ))}
      </div>
    </div>
  );
}

