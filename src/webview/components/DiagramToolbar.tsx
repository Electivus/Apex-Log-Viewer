import React from 'react';

export interface KindStyle {
  stroke: string;
  fill: string;
}

interface Props {
  hideSystem: boolean;
  collapseRepeats: boolean;
  onToggleHideSystem: (checked: boolean) => void;
  onToggleCollapseRepeats: (checked: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  kindStyles: Record<'Trigger' | 'Flow' | 'Class' | 'Other', KindStyle>;
}

export function DiagramToolbar({
  hideSystem,
  collapseRepeats,
  onToggleHideSystem,
  onToggleCollapseRepeats,
  onExpandAll,
  onCollapseAll,
  kindStyles
}: Props) {
  const kinds: Array<'Trigger' | 'Flow' | 'Class' | 'Other'> = ['Trigger', 'Flow', 'Class', 'Other'];
  return (
    <div className="toolbar">
      <label>
        <input type="checkbox" checked={hideSystem} onChange={e => onToggleHideSystem(e.target.checked)} /> Hide System
      </label>
      <label>
        <input type="checkbox" checked={collapseRepeats} onChange={e => onToggleCollapseRepeats(e.target.checked)} />{' '}
        Collapse repeats
      </label>
      <button onClick={onExpandAll}>Expand all</button>
      <button onClick={onCollapseAll}>Collapse all</button>
      <div className="legend">
        {kinds.map(kind => (
          <span className="item" key={kind}>
            <span
              className="swatch"
              style={{
                background: kindStyles[kind].fill,
                border: `1px solid ${kindStyles[kind].stroke}`
              }}
            />
            {kind}
          </span>
        ))}
      </div>
    </div>
  );
}
