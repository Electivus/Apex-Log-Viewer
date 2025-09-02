import { useState, useCallback } from 'react';
import type { DiagramState, DiagramNested, DiagramNestedWithCount } from '../../shared/diagramTypes';

export function useDiagramState() {
  const [hideSystem, setHideSystem] = useState(true);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [collapsedUnits, setCollapsedUnits] = useState<Set<string>>(new Set());
  const [allUnitIds, setAllUnitIds] = useState<string[]>([]);
  const [collapseInitialized, setCollapseInitialized] = useState(false);

  const state: DiagramState = {
    hideSystem,
    collapseRepeats,
    collapsedUnits,
    allUnitIds,
    collapseInitialized
  };

  const toggleHideSystem = useCallback(() => {
    setHideSystem(prev => !prev);
  }, []);

  const toggleCollapseRepeats = useCallback(() => {
    setCollapseRepeats(prev => !prev);
  }, []);

  const expandAll = useCallback(() => {
    setCollapsedUnits(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedUnits(new Set(allUnitIds));
  }, [allUnitIds]);

  const toggleUnit = useCallback((unitId: string) => {
    setCollapsedUnits(prev => {
      const newSet = new Set(prev);
      if (newSet.has(unitId)) {
        newSet.delete(unitId);
      } else {
        newSet.add(unitId);
      }
      return newSet;
    });
  }, []);

  const initializeUnits = useCallback(
    (unitIds: string[]) => {
      setAllUnitIds(unitIds);
      if (!collapseInitialized) {
        setCollapsedUnits(new Set()); // Start with all units expanded
        setCollapseInitialized(true);
      } else {
        // Keep only existing unit IDs that are still valid
        setCollapsedUnits(prev => new Set(unitIds.filter(id => prev.has(id))));
      }
    },
    [collapseInitialized]
  );

  return {
    state,
    actions: {
      toggleHideSystem,
      toggleCollapseRepeats,
      expandAll,
      collapseAll,
      toggleUnit,
      initializeUnits
    }
  };
}
