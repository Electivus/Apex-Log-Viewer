export type CallTreeNodeId = string;

export type CallTreeMetrics = {
  totalTimeMs: number; // time including subtree
  ownTimeMs: number; // total - sum(children.totalTimeMs)
  soql?: number;
  dml?: number;
  callout?: number;
  soqlTimeMs?: number;
  dmlTimeMs?: number;
  calloutTimeMs?: number;
  cpuMs?: number;
  heapBytes?: number;
  count?: number; // for merged nodes
};

export type CallRef = {
  className: string; // e.g., MyClass
  method: string; // e.g., doWork(String)
  label: string; // raw label from log
};

export type CallTreeNode = {
  id: CallTreeNodeId; // unique per occurrence (start index) or per merged key
  ref: CallRef;
  children: CallTreeNode[];
  parents?: CallTreeNode[]; // optional backlinks for backtraces (filled on model)
  metrics: CallTreeMetrics;
  // Optional linking back to the original nested frame for navigation
  start?: number;
  end?: number;
  depth?: number;
  actor?: string; // Class:Foo
};

export type CallTreeModel = {
  roots: CallTreeNode[]; // top-level methods
  all: Map<CallTreeNodeId, CallTreeNode>;
  // Indexes for search and merge/backtraces
  bySignature: Map<string, CallTreeNode[]>; // key: ClassName#methodSig (raw label)
  parentsBySignature: Map<string, Set<string>>; // calleeSig -> set of caller signatures
  totals: { totalTimeMs: number };
};

export type BuildOptions = {
  // When true, treat every occurrence independently and compute parent/child relations by time nesting.
  // When false, behavior is the same (this option is reserved for future variations).
  occurrences?: boolean;
};

export function signatureFromLabel(actor: string, label: string): { className: string; method: string; sig: string } {
  const raw = (label || '').trim();
  const noArgs = raw.split("|")[0] || raw;
  const beforeParen = noArgs.split("(")[0] || noArgs;
  let className = '';
  let method = beforeParen;
  // Labels usually are like: "MyClass.myMethod(String)" or "ns__MyClass.do()"
  const dot = beforeParen.lastIndexOf('.');
  if (dot > 0) {
    className = beforeParen.slice(0, dot);
    method = raw.slice(dot + 1);
  } else if (actor.startsWith('Class:')) {
    className = actor.slice('Class:'.length);
  }
  const sig = `${className}#${method}`;
  return { className, method, sig };
}

