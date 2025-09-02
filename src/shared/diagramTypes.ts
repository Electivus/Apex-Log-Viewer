// Shared types for diagram functionality
export type DiagramNested = {
  actor: string;
  label: string;
  start: number;
  end?: number;
  depth: number;
  kind: 'unit' | 'method';
};

export type DiagramGraph = {
  nodes: { id: string; label: string; kind?: string }[];
  sequence: { from?: string; to: string; label?: string }[];
  nested?: DiagramNested[];
};

export type DiagramNestedWithCount = DiagramNested & { count?: number };

export type DiagramKind = 'Trigger' | 'Flow' | 'Class' | 'Other';

export type DiagramStyle = {
  stroke: string;
  fill: string;
};

export type DiagramState = {
  hideSystem: boolean;
  collapseRepeats: boolean;
  collapsedUnits: Set<string>;
  allUnitIds: string[];
  collapseInitialized: boolean;
};

// Messages for diagram webview
export type DiagramMessage = { type: 'ready' } | { type: 'graph'; graph: DiagramGraph };
