import React from 'react';
import { DiagramLegend } from './DiagramLegend';
import { commonButtonStyle } from '../styles';

type DiagramToolbarProps = {
  hideSystem: boolean;
  collapseRepeats: boolean;
  onToggleHideSystem: () => void;
  onToggleCollapseRepeats: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
};

export function DiagramToolbar({
  hideSystem,
  collapseRepeats,
  onToggleHideSystem,
  onToggleCollapseRepeats,
  onExpandAll,
  onCollapseAll
}: DiagramToolbarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 10px',
        position: 'relative'
      }}
    >
      <label>
        <input type="checkbox" checked={hideSystem} onChange={onToggleHideSystem} />
        {' Hide System'}
      </label>

      <label>
        <input type="checkbox" checked={collapseRepeats} onChange={onToggleCollapseRepeats} />
        {' Collapse repeats'}
      </label>

      <button onClick={onExpandAll} style={commonButtonStyle}>
        Expand all
      </button>

      <button onClick={onCollapseAll} style={commonButtonStyle}>
        Collapse all
      </button>

      <DiagramLegend />
    </div>
  );
}
