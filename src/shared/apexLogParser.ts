// Lightweight Apex Debug Log parser to extract a call graph suitable for
// a simple diagram overlay. This is not a full log parser — it focuses on
// CODE_UNIT_* and METHOD_* events to infer relationships between triggers,
// classes and flows. It also captures the default log levels from the head
// of the file (e.g., "64.0 APEX_CODE,FINEST;DB,INFO;...").

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
  };
};

export type LogGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sequence: SequenceEvent[];
  flow: FlowSpan[];
  nested: NestedFrame[];
};

function normalizeLevel(level: string | undefined): string | undefined {
  const l = (level || '').toUpperCase().trim();
  const allowed = ['FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'NONE'];
  return allowed.includes(l) ? l : undefined;
}

// Parse a line like:
//   "64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;DB,INFO;SYSTEM,DEBUG;..."
export function parseDefaultLogLevels(headLines: string[]): LogLevels | undefined {
  const first = headLines.find(l => /\bAPEX_CODE\b.*[,;]/.test(l));
  if (!first) return undefined;
  const map: LogLevels = {};
  // Take the substring starting at the first category to avoid leading version numbers
  const start = first.indexOf('APEX_');
  const payload = start >= 0 ? first.slice(start) : first;
  for (const part of payload.split(';')) {
    const m = part.match(/([A-Z_]+)\s*,\s*([A-Z]+)/);
    if (m) {
      const [, key, lvl] = m as unknown as [string, string, string];
      const norm = normalizeLevel(lvl);
      if (norm) (map as Record<string, string>)[key] = norm;
    }
  }
  return Object.keys(map).length ? map : undefined;
}

function nodeId(kind: GraphNode['kind'], name: string): string {
  return `${kind}:${name}`;
}

function upsertNode(
  nodesById: Map<string, GraphNode>,
  kind: GraphNode['kind'],
  name: string,
  levels?: LogLevels
): GraphNode {
  const id = nodeId(kind, name);
  const existing = nodesById.get(id);
  if (existing) {
    return existing;
  }
  const node: GraphNode = { id, label: name, kind, levels };
  nodesById.set(id, node);
  return node;
}

function incEdge(edgesByKey: Map<string, GraphEdge>, from: string, to: string) {
  if (from === to) return; // ignore self loops
  const key = `${from}|${to}`;
  const existing = edgesByKey.get(key);
  if (existing) {
    existing.count++;
    return existing;
  }
  const edge: GraphEdge = { from, to, count: 1 };
  edgesByKey.set(key, edge);
  return edge;
}

type Unit = { kind: GraphNode['kind']; name: string; id: string };

/**
 * Parse Apex log text into a simple call graph.
 * - Detects default log levels from the head
 * - Creates nodes for triggers, classes, and flows
 * - Adds edges when a class method is entered from a different owner (trigger/class/flow)
 */
export function parseApexLogToGraph(text: string, maxLines?: number): LogGraph {
  const lines = text.split(/\r?\n/);
  const head = lines.slice(0, 8);
  const defaults = parseDefaultLogLevels(head);

  const nodesById = new Map<string, GraphNode>();
  const edgesByKey = new Map<string, GraphEdge>();

  const unitStack: Unit[] = [];
  const methodStack: string[] = []; // class names
  const sequence: SequenceEvent[] = [];
  const flow: FlowSpan[] = [];
  const laneStacks = new Map<string, FlowSpan[]>();
  const pushSpan = (actor: string, label: string, kind: FlowSpan['kind']) => {
    const stack = laneStacks.get(actor) || [];
    const span: FlowSpan = { actor, label, start: sequence.length, depth: stack.length, kind };
    stack.push(span);
    laneStacks.set(actor, stack);
    flow.push(span);
    return span;
  };
  const endSpan = (actor: string) => {
    const stack = laneStacks.get(actor);
    if (!stack || stack.length === 0) return;
    const span = stack.pop()!;
    if (span.end === undefined || span.end === null) span.end = Math.max(span.start + 1, sequence.length);
  };

  // Global nested frames (single-column view)
  const nested: NestedFrame[] = [];
  const nestedStack: NestedFrame[] = [];
  // Track most recently closed actors for attribution after stacks are cleared
  let lastClosedMethodActor: string | undefined;
  let lastClosedUnitActor: string | undefined;
  const pushNested = (actor: string, label: string, kind: NestedFrame['kind']) => {
    const frame: NestedFrame = { actor, label, start: sequence.length, depth: nestedStack.length, kind };
    nested.push(frame);
    nestedStack.push(frame);
  };
  const popNestedByActor = (actor: string, kind?: NestedFrame['kind']) => {
    for (let i = nestedStack.length - 1; i >= 0; i--) {
      const fr = nestedStack[i]!;
      if (fr.actor === actor && (!kind || fr.kind === kind)) {
        fr.end = Math.max(fr.start + 1, sequence.length);
        nestedStack.splice(i, 1);
        if (fr.kind === 'method') lastClosedMethodActor = fr.actor;
        else if (fr.kind === 'unit') lastClosedUnitActor = fr.actor;
        return fr;
      }
    }
    return undefined;
  };

  function currentOwnerId(): string | undefined {
    // Prefer the last method's class; otherwise the current unit
    if (methodStack.length) {
      const cls = methodStack[methodStack.length - 1]!;
      return nodeId('Class', cls);
    }
    if (unitStack.length) {
      return unitStack[unitStack.length - 1]!.id;
    }
    return undefined;
  }

  const rePrefixTime = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*\((\d+)\)\|/;
  const reCodeUnitStart = /\|CODE_UNIT_STARTED\|(.+)$/;
  const reCodeUnitFinish = /\|CODE_UNIT_FINISHED\|(.+)$/;
  const reMethodEntry = /\|METHOD_ENTRY\|(.+)$/;
  const reMethodExit = /\|METHOD_EXIT\|(.+)$/;

  const isTriggerDescriptor = (s: string) => /\btrigger event\b/i.test(s);

  const getClassNameFromMethodSig = (sig: string): string | undefined => {
    // Examples:
    //   "MyClass.myMethod(String)"
    //   "ns__MyClass.handler(Map<Id,SObject>)"
    //   "System.List<...>.add(Object)" (ignore System.*)
    const noArgs = sig.split('(')[0]!.trim();
    const parts = noArgs.split('.');
    if (parts.length >= 2) {
      const method = parts.pop();
      const cls = parts.join('.');
      if (cls && method) {
        // Drop well-known system prefixes to avoid noisy nodes
        if (/^System(\.|$)/.test(cls)) return undefined;
        return cls;
      }
    }
    return undefined;
  };

  const getUnit = (payload: string): Unit | undefined => {
    // payload is the substring after CODE_UNIT_STARTED| ... we need the right-most human label
    const parts = payload
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1] || '';
    const lastButOne = parts.length >= 2 ? parts[parts.length - 2] || '' : '';
    let label = last;
    // For triggers, the last part can be a path like "__sfdc_trigger/Name"; prefer the human label
    if (/__sfdc_trigger\//.test(last) && lastButOne) {
      label = lastButOne;
    }
    // Normalize some shapes
    if (/^Flow:/i.test(label)) {
      const name = label.replace(/^Flow:/i, '').trim() || 'Flow';
      const id = nodeId('Flow', name);
      upsertNode(nodesById, 'Flow', name, defaults);
      return { kind: 'Flow', name, id };
    }
    if (/^Class\./.test(label)) {
      // Class.MyClass.method
      const m = label.match(/^Class\.(.+?)\./);
      const name = (m && m[1]) || label.replace(/^Class\./, '');
      const id = nodeId('Class', name);
      upsertNode(nodesById, 'Class', name, defaults);
      return { kind: 'Class', name, id };
    }
    if (isTriggerDescriptor(label)) {
      // e.g., "MyTrigger on Account trigger event BeforeInsert"
      const name = label.split(' on ')[0]!.trim();
      const id = nodeId('Trigger', name);
      upsertNode(nodesById, 'Trigger', name, defaults);
      return { kind: 'Trigger', name, id };
    }
    // Fallback: use best guess and treat as Other
    const id = nodeId('Other', label || 'CodeUnit');
    upsertNode(nodesById, 'Other', label || 'CodeUnit', defaults);
    return { kind: 'Other', name: label || 'CodeUnit', id };
  };

  const getFinishLabel = (payload: string): string => {
    const parts = payload
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);
    // Prefer human label when last is a path
    const last = parts[parts.length - 1] || '';
    const lastButOne = parts.length >= 2 ? parts[parts.length - 2] || '' : '';
    if (/__sfdc_trigger\//.test(last) && lastButOne) return lastButOne;
    return last;
  };

  // Normalize a CODE_UNIT_FINISHED human label to the unit "name" we used on start
  const normalizeFinishedUnitName = (label: string): string => {
    if (!label) return label;
    // Flow:Foo => Foo
    if (/^Flow:/i.test(label)) return label.replace(/^Flow:/i, '').trim();
    // Class.MyClass.something => MyClass; Class.MyClass => MyClass
    if (/^Class\./.test(label)) {
      const m = label.match(/^Class\.(.+?)(?:\.|$)/);
      return m && m[1] ? m[1] : label.replace(/^Class\./, '');
    }
    // Trigger descriptors: "MyTrigger on X trigger event ..." => "MyTrigger"
    if (isTriggerDescriptor(label)) return label.split(' on ')[0]!.trim();
    return label;
  };

  const max = typeof maxLines === 'number' ? Math.max(1, maxLines) : lines.length;
  // Cumulative snapshot tracking for CPU/heap
  let lastCpuMs = 0;
  let lastHeapBytes = 0;
  let inCumBlock: 'LIMITS' | 'PROF' | undefined;
  let snapCpuMs: number | undefined;
  let snapHeapBytes: number | undefined;
  for (let i = 0; i < Math.min(lines.length, max); i++) {
    const line = lines[i] || '';
    const lineUpper = line.toUpperCase();
    let m: RegExpMatchArray | null;

    const tm = line.match(rePrefixTime);
    const time = tm?.[1];
    const nanos = tm?.[2];

    // --- Lightweight profiling counters (best-effort) ---
    // Attribute counts to the current method frame (if any) and enclosing unit frame.
    // Heuristics prefer BEGIN markers to avoid double-counting END/content lines.
    const markProfile = (kind: 'soql' | 'dml' | 'callout') => {
      // Find the current method frame (top-most for current class actor)
      const curMethodActor = methodStack.length ? nodeId('Class', methodStack[methodStack.length - 1]!) : undefined;
      if (curMethodActor) {
        for (let idx = nestedStack.length - 1; idx >= 0; idx--) {
          const fr = nestedStack[idx]!;
          if (fr.actor === curMethodActor && fr.kind === 'method') {
            (fr.profile ||= {} as any);
            (fr.profile as any)[kind] = ((fr.profile as any)[kind] || 0) + 1;
            break;
          }
        }
      }
      // Also attribute to the current unit frame, if present
      if (unitStack.length) {
        const curUnitActor = unitStack[unitStack.length - 1]!.id;
        for (let idx = nestedStack.length - 1; idx >= 0; idx--) {
          const fr = nestedStack[idx]!;
          if (fr.actor === curUnitActor && fr.kind === 'unit') {
            (fr.profile ||= {} as any);
            (fr.profile as any)[kind] = ((fr.profile as any)[kind] || 0) + 1;
            break;
          }
        }
      }
    };

    // SOQL (count BEGIN and QUERY_MORE only to avoid double-counting)
    if (/(^|\|)SOQL_EXECUTE_BEGIN(\||$)/.test(lineUpper) || /(^|\|)QUERY_MORE(\||$)/.test(lineUpper)) {
      markProfile('soql');
    }
    // DML
    if (/(^|\|)DML_BEGIN(\||$)/.test(lineUpper)) {
      markProfile('dml');
    }
    // Callouts / HTTP
    if (/(^|\|)CALLOUT_REQUEST(\||$)/.test(lineUpper) || /(^|\|)HTTP(\||$)/.test(lineUpper)) {
      markProfile('callout');
    }

    // Cumulative snapshot blocks start
    if (/(^|\|)CUMULATIVE_LIMIT_USAGE(\||$)/.test(lineUpper)) {
      inCumBlock = 'LIMITS';
      snapCpuMs = undefined;
      snapHeapBytes = undefined;
      continue;
    }
    if (/(^|\|)CUMULATIVE_PROFILING(\||$)/.test(lineUpper)) {
      inCumBlock = 'PROF';
      snapCpuMs = undefined;
      snapHeapBytes = undefined;
      continue;
    }
    // Parse values within cumulative blocks
    if (inCumBlock) {
      // Maximum CPU time: 127 out of 10000
      let mm = line.match(/Maximum CPU time:\s*(\d+)\s+out of/i);
      if (mm) {
        const v = parseInt(mm[1]!, 10);
        if (!Number.isNaN(v)) snapCpuMs = v;
      }
      // Maximum heap size: 1158 out of 6000000
      mm = line.match(/Maximum heap size:\s*(\d+)\s+out of/i);
      if (mm) {
        const v = parseInt(mm[1]!, 10);
        if (!Number.isNaN(v)) snapHeapBytes = v;
      }
      // End of block => attribute deltas
      if (/(^|\|)CUMULATIVE_LIMIT_USAGE_END(\||$)/.test(lineUpper) || /(^|\|)CUMULATIVE_PROFILING_END(\||$)/.test(lineUpper)) {
        const curCpu = typeof snapCpuMs === 'number' ? snapCpuMs : lastCpuMs;
        const curHeap = typeof snapHeapBytes === 'number' ? snapHeapBytes : lastHeapBytes;
        let dCpu = Math.max(0, curCpu - lastCpuMs);
        let dHeap = Math.max(0, curHeap - lastHeapBytes);
        // Update snapshots for next time
        lastCpuMs = curCpu;
        lastHeapBytes = curHeap;
        if (dCpu || dHeap) {
          const addToFrame = (actor: string | undefined, k: NestedFrame['kind'], kind: 'cpuMs' | 'heapBytes', amount: number) => {
            if (!actor || !amount) return false;
            for (let idx = nestedStack.length - 1; idx >= 0; idx--) {
              const fr = nestedStack[idx]!;
              if (fr.actor === actor && fr.kind === k) {
                (fr.profile ||= {} as any);
                (fr.profile as any)[kind] = ((fr.profile as any)[kind] || 0) + amount;
                return true;
              }
            }
            for (let i = nested.length - 1; i >= 0; i--) {
              const fr = nested[i]!;
              if (fr.actor === actor && fr.kind === k) {
                (fr.profile ||= {} as any);
                (fr.profile as any)[kind] = ((fr.profile as any)[kind] || 0) + amount;
                return true;
              }
            }
            return false;
          };
          const addAmount = (kind: 'cpuMs' | 'heapBytes', amount: number) => {
            if (!amount) return;
            const curMethodActor = methodStack.length ? nodeId('Class', methodStack[methodStack.length - 1]!) : undefined;
            const curUnitActor = unitStack.length ? unitStack[unitStack.length - 1]!.id : undefined;
            addToFrame(curMethodActor || lastClosedMethodActor, 'method', kind, amount);
            addToFrame(curUnitActor || lastClosedUnitActor, 'unit', kind, amount);
          };
          if (dCpu) addAmount('cpuMs', dCpu);
          if (dHeap) addAmount('heapBytes', dHeap);
        }
        inCumBlock = undefined;
        snapCpuMs = undefined;
        snapHeapBytes = undefined;
        continue;
      }
    }

    if ((m = line.match(reCodeUnitStart))) {
      const unit = getUnit(m[1] || '');
      if (unit) {
        // Sequence edge from current owner to new unit
        const owner = currentOwnerId();
        if (owner) sequence.push({ from: owner, to: unit.id, label: 'CODE_UNIT_STARTED', time, nanos });
        else sequence.push({ to: unit.id, label: 'CODE_UNIT_STARTED', time, nanos });
        // Flow span on the unit's own lane
        pushSpan(unit.id, unit.name, 'unit');
        // Global nested frame
        pushNested(unit.id, unit.name, 'unit');
        unitStack.push(unit);
      }
      continue;
    }
    if ((m = line.match(reCodeUnitFinish))) {
      const raw = getFinishLabel(m[1] || '');
      const label = normalizeFinishedUnitName(raw);
      // Pop until a matching or any unit, to be resilient to mismatched logs
      while (unitStack.length) {
        const top = unitStack[unitStack.length - 1]!;
        if (top.name === label || top.id.endsWith(`:${label}`)) {
          unitStack.pop();
          lastClosedUnitActor = top.id;
          endSpan(top.id);
          popNestedByActor(top.id, 'unit');
          break;
        }
        unitStack.pop();
      }
      // Clearing method stack when a unit ends keeps ownership sane
      if (methodStack.length) {
        const last = methodStack[methodStack.length - 1]!;
        lastClosedMethodActor = nodeId('Class', last);
      }
      methodStack.length = 0;
      continue;
    }
    if ((m = line.match(reMethodEntry))) {
      const payload = (m[1] || '').split('|').pop() || '';
      const cls = getClassNameFromMethodSig(payload);
      if (cls) {
        // Create node and edge from current owner
        const targetId = nodeId('Class', cls);
        upsertNode(nodesById, 'Class', cls, defaults);
        const owner = currentOwnerId();
        if (owner) {
          incEdge(edgesByKey, owner, targetId);
          sequence.push({ from: owner, to: targetId, label: payload, time, nanos });
        } else {
          sequence.push({ to: targetId, label: payload, time, nanos });
        }
        // Flow span on class lane
        pushSpan(targetId, payload, 'method');
        // Global nested frame
        pushNested(targetId, payload, 'method');
        methodStack.push(cls);
      }
      continue;
    }
    if ((m = line.match(reMethodExit))) {
      const payload = (m[1] || '').split('|').pop() || '';
      // METHOD_EXIT may log only the class name (no method signature). Try to infer.
      let cls = getClassNameFromMethodSig(payload);
      if (!cls) {
        const simple = (payload || '').trim();
        // e.g., "MyClass" — treat as class name if it looks sane
        if (simple && !/[()]/.test(simple)) cls = simple;
      }
      if (methodStack.length) {
        if (cls && methodStack.includes(cls)) {
          // Unwind the stack until we close the matching class to keep stack and spans aligned
          while (methodStack.length) {
            const top = methodStack.pop()!;
            const actor = nodeId('Class', top);
            endSpan(actor);
            popNestedByActor(actor, 'method');
            if (top === cls) break;
          }
          lastClosedMethodActor = nodeId('Class', cls);
        } else if (!cls) {
          // If we cannot infer a class, this could be a SYSTEM method exit (we don't track those).
          // Heuristic: if payload looks like a system signature or generic (contains System or generics/parentheses), ignore.
          const p = (payload || '').trim();
          const looksSystemish = /\bSystem\b/i.test(p) || /[()<>]/.test(p);
          if (!looksSystemish) {
            // Fallback: close the top-most method conservatively
            const top = methodStack.pop()!;
            const actor = nodeId('Class', top);
            endSpan(actor);
            popNestedByActor(actor, 'method');
            lastClosedMethodActor = actor;
          }
          // else: ignore exit as untracked system method
        } else {
          // cls present but not in stack: ignore to avoid desynchronizing the stack
        }
      }
      continue;
    }
  }

  const nodes = Array.from(nodesById.values());
  const edges = Array.from(edgesByKey.values());
  // Any spans left open: close them at final sequence length
  for (const [actor, stack] of laneStacks) {
    while (stack.length) {
      const span = stack.pop()!;
      if (span.end === undefined || span.end === null) span.end = Math.max(span.start + 1, sequence.length);
    }
  }
  // Close any nested frames left open
  while (nestedStack.length) {
    const fr = nestedStack.pop()!;
    if (fr.end === undefined || fr.end === null) fr.end = Math.max(fr.start + 1, sequence.length);
  }
  return { nodes, edges, sequence, flow, nested };
}
