export type LogLevels = Record<string, string>;

export type GraphNode = {
  id: string;
  label: string;
  kind: 'Trigger' | 'Class' | 'Flow' | 'Other';
  levels?: LogLevels;
};

export type GraphEdge = {
  from: string;
  to: string;
  count: number;
};

export type SequenceEvent = {
  from?: string;
  to: string;
  label?: string;
  time?: string;
  nanos?: string;
};

export type FlowSpan = {
  actor: string;
  label: string;
  start: number;
  end?: number;
  depth: number;
  kind: 'unit' | 'method';
  startNs?: number;
  endNs?: number;
};

export type NestedFrame = {
  actor: string;
  label: string;
  start: number;
  end?: number;
  depth: number;
  kind: 'unit' | 'method';
  profile?: {
    soql?: number;
    dml?: number;
    callout?: number;
    cpuMs?: number;
    heapBytes?: number;
    timeMs?: number;
    soqlTimeMs?: number;
    dmlTimeMs?: number;
    calloutTimeMs?: number;
  };
  startNs?: number;
  endNs?: number;
};

export type LogGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sequence: SequenceEvent[];
  flow: FlowSpan[];
  nested: NestedFrame[];
  issues?: LogIssue[];
};

export type LogIssue = {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  details?: string;
  line?: number;
};

