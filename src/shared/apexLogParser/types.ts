export type LogLevels = Record<string, string>;

export type GraphNode = {
  id: string; // stable id (e.g., kind:Name)
  label: string; // human friendly label
  kind: 'Trigger' | 'Class' | 'Flow' | 'Other';
  levels?: LogLevels; // default/inherited levels (best-effort)
};

export type GraphEdge = {
  from: string; // node id
  to: string; // node id
  count: number; // number of times observed
};

export type SequenceEvent = {
  from?: string; // node id (optional for first event)
  to: string; // node id
  label?: string;
  time?: string; // HH:MM:SS.mmm
  nanos?: string; // raw nanoseconds field in parentheses
};

export type FlowSpan = {
  actor: string; // node id (lane)
  label: string;
  start: number; // sequence index where it started
  end?: number; // sequence index where it finished
  depth: number; // nesting level within the same actor lane
  kind: 'unit' | 'method';
  // Timeline timestamps (nanoseconds from log prefix) for duration computation
  startNs?: number;
  endNs?: number;
};

export type NestedFrame = {
  actor: string; // node id
  label: string; // display label
  start: number; // sequence index at start
  end?: number; // sequence index at end (exclusive)
  depth: number; // global stack depth
  kind: 'unit' | 'method';
  // Lightweight profiling counters captured while the frame is active
  profile?: {
    soql?: number;
    dml?: number;
    callout?: number;
    cpuMs?: number;
    heapBytes?: number;
    // Wall-clock time derived from log timeline (in milliseconds)
    timeMs?: number;
    // Per-category wall times (ms) from BEGIN/END pairs
    soqlTimeMs?: number;
    dmlTimeMs?: number;
    calloutTimeMs?: number;
  };
  // Timeline timestamps (nanoseconds from log prefix) for duration computation
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
