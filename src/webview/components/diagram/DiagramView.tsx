import React, { useEffect, useMemo } from 'react';
import type { DiagramGraph } from '../../../shared/diagramTypes';
import { DiagramToolbar } from './DiagramToolbar';
import { DiagramCanvas } from './DiagramCanvas';
import { useDiagramState } from '../../hooks/useDiagramState';
import { useDiagramData } from '../../hooks/useDiagramData';

type DiagramViewProps = {
  graph?: DiagramGraph;
};

export function DiagramView({ graph }: DiagramViewProps) {
  const { state, actions } = useDiagramState();
  const { utils } = useDiagramData();

  // Process and filter frames
  const frames = useMemo(() => {
    return utils.filterAndCollapse(graph?.nested, state.hideSystem, state.collapseRepeats);
  }, [graph?.nested, state.hideSystem, state.collapseRepeats, utils]);

  // Initialize unit IDs when frames change
  useEffect(() => {
    const unitIds = frames.filter(f => f.kind === 'unit').map(utils.unitId);
    actions.initializeUnits(unitIds);
  }, [frames, utils, actions]);

  return (
    <div
      style={{
        height: '100%',
        position: 'relative'
      }}
    >
      <DiagramToolbar
        hideSystem={state.hideSystem}
        collapseRepeats={state.collapseRepeats}
        onToggleHideSystem={actions.toggleHideSystem}
        onToggleCollapseRepeats={actions.toggleCollapseRepeats}
        onExpandAll={actions.expandAll}
        onCollapseAll={actions.collapseAll}
      />

      <DiagramCanvas frames={frames} state={state} onToggleUnit={actions.toggleUnit} />
    </div>
  );
}
