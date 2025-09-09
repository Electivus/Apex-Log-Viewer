// Lightweight Apex Debug Log parser to extract a call graph suitable for
// a simple diagram overlay. This is not a full log parser — it focuses on
// CODE_UNIT_* and METHOD_* events to infer relationships between triggers,
// classes and flows. It also captures the default log levels from the head
// of the file (e.g., "64.0 APEX_CODE,FINEST;DB,INFO;...").

import type {
  FlowSpan,
  GraphEdge,
  GraphNode,
  LogGraph,
  LogIssue,
  LogLevels,
  NestedFrame,
  SequenceEvent
} from './types';
import { parseDefaultLogLevels } from './levels';
import { nodeId, upsertNode, incEdge, addSequenceEvent } from './graph';

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
  const issues: LogIssue[] = [];

  const nodesById = new Map<string, GraphNode>();
  const edgesByKey = new Map<string, GraphEdge>();

  const unitStack: Unit[] = [];
  const methodStack: string[] = []; // class names
  const sequence: SequenceEvent[] = [];
  const flow: FlowSpan[] = [];
  const laneStacks = new Map<string, FlowSpan[]>();
  const pushSpan = (actor: string, label: string, kind: FlowSpan['kind'], startNs?: number) => {
    const stack = laneStacks.get(actor) || [];
    const span: FlowSpan = { actor, label, start: sequence.length, depth: stack.length, kind, startNs };
    stack.push(span);
    laneStacks.set(actor, stack);
    flow.push(span);
    return span;
  };
  const endSpan = (actor: string, endNs?: number) => {
    const stack = laneStacks.get(actor);
    if (!stack || stack.length === 0) return;
    const span = stack.pop()!;
    if (span.end === undefined || span.end === null) span.end = Math.max(span.start + 1, sequence.length);
    if (typeof endNs === 'number') span.endNs = endNs;
  };

  // Global nested frames (single-column view)
  const nested: NestedFrame[] = [];
  const nestedStack: NestedFrame[] = [];
  // Track most recently closed actors for attribution after stacks are cleared
  let lastClosedMethodActor: string | undefined;
  let lastClosedUnitActor: string | undefined;
  const pushNested = (actor: string, label: string, kind: NestedFrame['kind'], startNs?: number) => {
    const frame: NestedFrame = { actor, label, start: sequence.length, depth: nestedStack.length, kind, startNs };
    nested.push(frame);
    nestedStack.push(frame);
  };
  const popNestedByActor = (actor: string, kind?: NestedFrame['kind'], endNs?: number) => {
    for (let i = nestedStack.length - 1; i >= 0; i--) {
      const fr = nestedStack[i]!;
      if (fr.actor === actor && (!kind || fr.kind === kind)) {
        fr.end = Math.max(fr.start + 1, sequence.length);
        if (typeof endNs === 'number') fr.endNs = endNs;
        // Compute timeline duration in ms using start/end nanoseconds if available
        if (typeof fr.startNs === 'number' && typeof fr.endNs === 'number') {
          const delta = Math.max(0, fr.endNs - fr.startNs);
          const ms = Math.round(delta / 1_000_000);
          fr.profile ||= {};
          fr.profile.timeMs = (fr.profile.timeMs || 0) + ms;
        }
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
  // Category END markers for timing
  const reSoqlEnd = /(^|\|)SOQL_EXECUTE_END(\||$)/i;
  const reDmlEnd = /(^|\|)DML_END(\||$)/i;
  const reCalloutResp = /(^|\|)CALLOUT_RESPONSE(\||$)/i;

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
  // Stacks to time operations from BEGIN..END
  const soqlNsStack: number[] = [];
  const dmlNsStack: number[] = [];
  const calloutNsStack: number[] = [];

  const addTimedAmount = (kind: 'soqlTimeMs' | 'dmlTimeMs' | 'calloutTimeMs', amountMs: number) => {
    if (!amountMs) return;
    const addToFrame = (actor: string | undefined, k: NestedFrame['kind'], profileKey: typeof kind, amount: number) => {
      if (!actor || !amount) return false;
      for (let idx = nestedStack.length - 1; idx >= 0; idx--) {
        const fr = nestedStack[idx]!;
        if (fr.actor === actor && fr.kind === k) {
          (fr.profile ||= {} as any);
          (fr.profile as any)[profileKey] = ((fr.profile as any)[profileKey] || 0) + amount;
          return true;
        }
      }
      for (let i = nested.length - 1; i >= 0; i--) {
        const fr = nested[i]!;
        if (fr.actor === actor && fr.kind === k) {
          (fr.profile ||= {} as any);
          (fr.profile as any)[profileKey] = ((fr.profile as any)[profileKey] || 0) + amount;
          return true;
        }
      }
      return false;
    };
    const curMethodActor = methodStack.length ? nodeId('Class', methodStack[methodStack.length - 1]!) : undefined;
    const curUnitActor = unitStack.length ? unitStack[unitStack.length - 1]!.id : undefined;
    addToFrame(curMethodActor || lastClosedMethodActor, 'method', kind, amountMs);
    addToFrame(curUnitActor || lastClosedUnitActor, 'unit', kind, amountMs);
  };
  let lastSeenNs: number | undefined;
  // Guidance based on defaults
  const levelRank: Record<string, number> = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    FINE: 5,
    FINER: 6,
    FINEST: 7
  };
  const getRank = (lvl?: string) => (lvl ? (levelRank[(lvl || '').toUpperCase()] ?? -1) : -1);
  if (!defaults) {
    issues.push({
      severity: 'info',
      code: 'levels.missing',
      message: 'Default log levels not detected in header.',
      details:
        'Some features may be incomplete. Ensure the first lines include categories (e.g., APEX_CODE,FINEST;DB,INFO;CALLOUT,INFO;).'
    });
  } else {
    const apexCode = defaults['APEX_CODE'];
    if (getRank(apexCode) < getRank('FINEST')) {
      issues.push({
        severity: 'warning',
        code: 'levels.apex_code.low',
        message: 'APEX_CODE level below FINEST.',
        details: 'Method entries may be missing. Set APEX_CODE to FINEST for best results.'
      });
    }
    const db = defaults['DB'];
    if (getRank(db) < getRank('INFO')) {
      issues.push({
        severity: 'warning',
        code: 'levels.db.low',
        message: 'DB level below INFO.',
        details: 'SOQL/DML counters and timings may be incomplete. Set DB to INFO or higher.'
      });
    }
    const callout = defaults['CALLOUT'];
    if (getRank(callout) < getRank('INFO')) {
      issues.push({
        severity: 'warning',
        code: 'levels.callout.low',
        message: 'CALLOUT level below INFO.',
        details: 'Callout counters and timings may be incomplete. Set CALLOUT to INFO or higher.'
      });
    }
  }

  let missingPrefixCount = 0;
  let nonMonotonicCount = 0;
  let codeUnitStartCount = 0;
  let codeUnitFinishCount = 0;
  let methodEntryCount = 0;
  let methodExitCount = 0;
  let fallbackMethodExitClose = 0;
  for (let i = 0; i < Math.min(lines.length, max); i++) {
    const line = lines[i] || '';
    const lineUpper = line.toUpperCase();
    let m: RegExpMatchArray | null;

    const tm = line.match(rePrefixTime);
    const time = tm?.[1];
    const nanos = tm?.[2];
    if (!tm) missingPrefixCount++;
    const curNs = nanos ? parseInt(nanos, 10) : undefined;
    if (typeof curNs === 'number' && !Number.isNaN(curNs)) {
      if (typeof lastSeenNs === 'number' && curNs < lastSeenNs) nonMonotonicCount++;
      lastSeenNs = curNs;
    }

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
            fr.profile ||= {} as any;
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
            fr.profile ||= {} as any;
            (fr.profile as any)[kind] = ((fr.profile as any)[kind] || 0) + 1;
            break;
          }
        }
      }
    };

    // SOQL (count BEGIN and QUERY_MORE only to avoid double-counting)
    if (/(^|\|)SOQL_EXECUTE_BEGIN(\||$)/.test(lineUpper) || /(^|\|)QUERY_MORE(\||$)/.test(lineUpper)) {
      markProfile('soql');
      // Start timing only for explicit SOQL_EXECUTE_BEGIN
      if (/(^|\|)SOQL_EXECUTE_BEGIN(\||$)/.test(lineUpper) && typeof lastSeenNs === 'number') {
        soqlNsStack.push(lastSeenNs);
      }
    }
    // DML
    if (/(^|\|)DML_BEGIN(\||$)/.test(lineUpper)) {
      markProfile('dml');
      if (typeof lastSeenNs === 'number') dmlNsStack.push(lastSeenNs);
    }
    // Callouts: count only explicit CALLOUT_REQUEST to avoid overcounting generic HTTP lines
    if (/(^|\|)CALLOUT_REQUEST(\||$)/.test(lineUpper)) {
      markProfile('callout');
      if (typeof lastSeenNs === 'number') calloutNsStack.push(lastSeenNs);
    }

    // END markers -> compute durations
    if (reSoqlEnd.test(lineUpper)) {
      const startNs = soqlNsStack.pop();
      if (typeof startNs === 'number' && typeof lastSeenNs === 'number') {
        const delta = Math.max(0, lastSeenNs - startNs);
        const ms = Math.round(delta / 1_000_000);
        addTimedAmount('soqlTimeMs', ms);
      }
    }
    if (reDmlEnd.test(lineUpper)) {
      const startNs = dmlNsStack.pop();
      if (typeof startNs === 'number' && typeof lastSeenNs === 'number') {
        const delta = Math.max(0, lastSeenNs - startNs);
        const ms = Math.round(delta / 1_000_000);
        addTimedAmount('dmlTimeMs', ms);
      }
    }
    if (reCalloutResp.test(lineUpper)) {
      const startNs = calloutNsStack.pop();
      if (typeof startNs === 'number' && typeof lastSeenNs === 'number') {
        const delta = Math.max(0, lastSeenNs - startNs);
        const ms = Math.round(delta / 1_000_000);
        addTimedAmount('calloutTimeMs', ms);
      }
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
      codeUnitStartCount++;
      const unit = getUnit(m[1] || '');
      if (unit) {
        // Sequence edge from current owner to new unit
        const owner = currentOwnerId();
        if (owner)
          addSequenceEvent(sequence, { from: owner, to: unit.id, label: 'CODE_UNIT_STARTED', time, nanos });
        else addSequenceEvent(sequence, { to: unit.id, label: 'CODE_UNIT_STARTED', time, nanos });
        // Flow span on the unit's own lane
        pushSpan(unit.id, unit.name, 'unit', lastSeenNs);
        // Global nested frame
        pushNested(unit.id, unit.name, 'unit', lastSeenNs);
        unitStack.push(unit);
      }
      continue;
    }
    if ((m = line.match(reCodeUnitFinish))) {
      codeUnitFinishCount++;
      const raw = getFinishLabel(m[1] || '');
      const label = normalizeFinishedUnitName(raw);
      // Pop until a matching or any unit, to be resilient to mismatched logs
      while (unitStack.length) {
        const top = unitStack[unitStack.length - 1]!;
        if (top.name === label || top.id.endsWith(`:${label}`)) {
          unitStack.pop();
          lastClosedUnitActor = top.id;
          endSpan(top.id, lastSeenNs);
          popNestedByActor(top.id, 'unit', lastSeenNs);
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
      methodEntryCount++;
      const payload = (m[1] || '').split('|').pop() || '';
      const cls = getClassNameFromMethodSig(payload);
      if (cls) {
        // Create node and edge from current owner
        const targetId = nodeId('Class', cls);
        upsertNode(nodesById, 'Class', cls, defaults);
        const owner = currentOwnerId();
        if (owner) {
          incEdge(edgesByKey, owner, targetId);
          addSequenceEvent(sequence, { from: owner, to: targetId, label: payload, time, nanos });
        } else {
          addSequenceEvent(sequence, { to: targetId, label: payload, time, nanos });
        }
        // Flow span on class lane
        pushSpan(targetId, payload, 'method', lastSeenNs);
        // Global nested frame
        pushNested(targetId, payload, 'method', lastSeenNs);
        methodStack.push(cls);
      }
      continue;
    }
    if ((m = line.match(reMethodExit))) {
      methodExitCount++;
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
            endSpan(actor, lastSeenNs);
            popNestedByActor(actor, 'method', lastSeenNs);
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
            endSpan(actor, lastSeenNs);
            popNestedByActor(actor, 'method', lastSeenNs);
            lastClosedMethodActor = actor;
            fallbackMethodExitClose++;
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
      if (typeof lastSeenNs === 'number' && span.endNs === undefined) span.endNs = lastSeenNs;
    }
  }
  // Close any nested frames left open
  while (nestedStack.length) {
    const fr = nestedStack.pop()!;
    if (fr.end === undefined || fr.end === null) fr.end = Math.max(fr.start + 1, sequence.length);
    if (typeof lastSeenNs === 'number' && fr.endNs === undefined) fr.endNs = lastSeenNs;
    if (typeof fr.startNs === 'number' && typeof fr.endNs === 'number') {
      const delta = Math.max(0, fr.endNs - fr.startNs);
      const ms = Math.round(delta / 1_000_000);
      fr.profile ||= {};
      fr.profile.timeMs = (fr.profile.timeMs || 0) + ms;
    }
  }
  // Post-parse validations
  if (missingPrefixCount > 0) {
    issues.push({ severity: 'warning', code: 'timestamps.missing', message: `${missingPrefixCount} line(s) without time prefix.`, details: 'Timeline metrics rely on the (nanos) prefix. Some durations may be inaccurate.' });
  }
  if (nonMonotonicCount > 0) {
    issues.push({ severity: 'info', code: 'timestamps.non_monotonic', message: `Detected ${nonMonotonicCount} non-monotonic timestamp(s).`, details: 'Out-of-order timestamps can occur; timeline durations are clamped to non-negative.' });
  }
  if (codeUnitStartCount === 0) {
    issues.push({ severity: 'warning', code: 'events.code_unit.missing', message: 'No CODE_UNIT_* events found.', details: 'Diagram may be empty. Ensure APEX_CODE is set to FINEST.' });
  }
  if (methodEntryCount === 0) {
    issues.push({ severity: 'info', code: 'events.methods.missing', message: 'No METHOD_ENTRY events found.', details: 'Method timeline will be empty. Set APEX_CODE to FINEST.' });
  }
  if (methodEntryCount !== methodExitCount) {
    issues.push({ severity: 'info', code: 'events.methods.unbalanced', message: `METHOD_ENTRY (${methodEntryCount}) != METHOD_EXIT (${methodExitCount}).`, details: 'This can happen with system frames. Parser compensates, but durations may be rough.' });
  }
  if (unitStack.length > 0) {
    issues.push({ severity: 'warning', code: 'frames.unit.unclosed', message: `${unitStack.length} code unit(s) left open at end of log.`, details: 'Unclosed units reduce accuracy of durations and nesting.' });
  }
  if (methodStack.length > 0) {
    issues.push({ severity: 'info', code: 'frames.method.unclosed', message: `${methodStack.length} method frame(s) left open at end of log.` });
  }
  if (fallbackMethodExitClose > 0) {
    issues.push({ severity: 'info', code: 'methods.exit.fallback', message: `Closed ${fallbackMethodExitClose} method(s) by fallback due to ambiguous METHOD_EXIT entries.` });
  }
  if (soqlNsStack.length > 0) {
    issues.push({ severity: 'info', code: 'soql.open', message: `${soqlNsStack.length} SOQL_EXECUTE_BEGIN without SOQL_EXECUTE_END.` });
  }
  if (dmlNsStack.length > 0) {
    issues.push({ severity: 'info', code: 'dml.open', message: `${dmlNsStack.length} DML_BEGIN without DML_END.` });
  }
  if (calloutNsStack.length > 0) {
    issues.push({ severity: 'info', code: 'callout.open', message: `${calloutNsStack.length} CALLOUT_REQUEST without CALLOUT_RESPONSE.` });
  }

  return { nodes, edges, sequence, flow, nested, issues };
}
