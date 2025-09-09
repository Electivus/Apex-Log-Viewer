import type { NestedFrame } from '../apexLogParser/types';
import { signatureFromLabel } from './types';
import type { BuildOptions, CallTreeModel, CallTreeNode } from './types';

function safeTimeMs(fr: NestedFrame): number {
  const p = fr.profile || {};
  if (typeof p.timeMs === 'number') return Math.max(0, p.timeMs);
  // Fallback from ns when available
  if (typeof fr.startNs === 'number' && typeof fr.endNs === 'number') {
    const raw = Math.round(Math.max(0, fr.endNs - fr.startNs) / 1_000_000);
    return raw;
  }
  // Fallback from sequence index
  const delta = (fr.end ?? fr.start + 1) - fr.start;
  return Math.max(0, delta);
}

export function buildCallTree(frames: NestedFrame[], opts?: BuildOptions): CallTreeModel {
  const options = { occurrences: true, ...(opts || {}) };
  // Only method frames participate in the call tree
  const methods = frames.filter(f => f.kind === 'method').slice().sort((a, b) => a.start - b.start || a.depth - b.depth);
  const stack: CallTreeNode[] = [];
  const all = new Map<string, CallTreeNode>();
  const roots: CallTreeNode[] = [];
  const bySignature = new Map<string, CallTreeNode[]>();
  const parentsBySignature = new Map<string, Set<string>>();

  for (const fr of methods) {
    // Maintain nesting based on start/end
    while (stack.length && (stack[stack.length - 1]!.end ?? Number.POSITIVE_INFINITY) <= fr.start) {
      stack.pop();
    }
    const { className, method, sig } = signatureFromLabel(fr.actor, fr.label);

    const metrics = {
      totalTimeMs: safeTimeMs(fr),
      ownTimeMs: 0,
      soql: fr.profile?.soql || 0,
      dml: fr.profile?.dml || 0,
      callout: fr.profile?.callout || 0,
      soqlTimeMs: fr.profile?.soqlTimeMs || 0,
      dmlTimeMs: fr.profile?.dmlTimeMs || 0,
      calloutTimeMs: fr.profile?.calloutTimeMs || 0,
      cpuMs: fr.profile?.cpuMs || 0,
      heapBytes: fr.profile?.heapBytes || 0
    };
    const node: CallTreeNode = {
      id: `${fr.actor}:${fr.start}`,
      ref: { className, method, label: fr.label },
      children: [],
      metrics,
      start: fr.start,
      end: fr.end,
      depth: fr.depth,
      actor: fr.actor
    };
    all.set(node.id, node);
    // Index for search / merging
    const arr = bySignature.get(sig) || [];
    arr.push(node);
    bySignature.set(sig, arr);

    if (stack.length) {
      const parent = stack[stack.length - 1]!;
      (node.parents ||= []).push(parent);
      parent.children.push(node);
      // Track signature parentage for backtraces
      const pSig = signatureFromLabel(parent.actor!, parent.ref.label).sig;
      const set = parentsBySignature.get(sig) || new Set<string>();
      set.add(pSig);
      parentsBySignature.set(sig, set);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  // Compute own time = total - sum(children.total)
  function computeOwnTimes(n: CallTreeNode): number {
    const childrenTotal = n.children.reduce((m, c) => m + computeOwnTimes(c), 0);
    const own = Math.max(0, n.metrics.totalTimeMs - childrenTotal);
    n.metrics.ownTimeMs = own;
    return n.metrics.totalTimeMs;
  }
  for (const r of roots) computeOwnTimes(r);

  const totalTime = roots.reduce((m, r) => m + r.metrics.totalTimeMs, 0);
  const model: CallTreeModel = { roots, all, bySignature, parentsBySignature, totals: { totalTimeMs: totalTime } };
  return model;
}

export function mergeOccurrences(model: CallTreeModel, signature: string): CallTreeModel {
  // When merging, treat the selected signature as root. Aggregate all its occurrences and their subtrees.
  const occ = model.bySignature.get(signature) || [];
  const bySig = new Map<string, CallTreeNode>();
  const makeNode = (sig: string, sample?: CallTreeNode): CallTreeNode => {
    const existing = bySig.get(sig);
    if (existing) return existing;
    // Parse parts from a sample occurrence or fall back to sig splitting
    const className = sample?.ref.className || sig.split('#')[0] || '';
    const method = sample?.ref.method || sig.split('#')[1] || '';
    const n: CallTreeNode = {
      id: `merged:${sig}`,
      ref: { className, method, label: `${className}.${method}` },
      children: [],
      metrics: { totalTimeMs: 0, ownTimeMs: 0, count: 0 }
    };
    bySig.set(sig, n);
    return n;
  };

  // DFS across each occurrence to aggregate into the merged tree
  for (const rootOcc of occ) {
    const rootSig = signatureFromLabel(rootOcc.actor!, rootOcc.ref.label).sig;
    const root = makeNode(rootSig, rootOcc);
    root.metrics.count = (root.metrics.count || 0) + 1;
    root.metrics.totalTimeMs += rootOcc.metrics.totalTimeMs;
    root.metrics.ownTimeMs += rootOcc.metrics.ownTimeMs;
    root.metrics.soql = (root.metrics.soql || 0) + (rootOcc.metrics.soql || 0);
    root.metrics.dml = (root.metrics.dml || 0) + (rootOcc.metrics.dml || 0);
    root.metrics.callout = (root.metrics.callout || 0) + (rootOcc.metrics.callout || 0);
    root.metrics.soqlTimeMs = (root.metrics.soqlTimeMs || 0) + (rootOcc.metrics.soqlTimeMs || 0);
    root.metrics.dmlTimeMs = (root.metrics.dmlTimeMs || 0) + (rootOcc.metrics.dmlTimeMs || 0);
    root.metrics.calloutTimeMs = (root.metrics.calloutTimeMs || 0) + (rootOcc.metrics.calloutTimeMs || 0);

    const stack: Array<{ occ: CallTreeNode; merged: CallTreeNode }> = [{ occ: rootOcc, merged: root }];
    while (stack.length) {
      const { occ, merged } = stack.pop()!;
      for (const childOcc of occ.children) {
        const cSig = signatureFromLabel(childOcc.actor!, childOcc.ref.label).sig;
        const childMerged = makeNode(cSig, childOcc);
        // Link if not already linked
        if (!merged.children.includes(childMerged)) merged.children.push(childMerged);
        // Aggregate metrics
        childMerged.metrics.count = (childMerged.metrics.count || 0) + 1;
        childMerged.metrics.totalTimeMs += childOcc.metrics.totalTimeMs;
        childMerged.metrics.ownTimeMs += childOcc.metrics.ownTimeMs;
        childMerged.metrics.soql = (childMerged.metrics.soql || 0) + (childOcc.metrics.soql || 0);
        childMerged.metrics.dml = (childMerged.metrics.dml || 0) + (childOcc.metrics.dml || 0);
        childMerged.metrics.callout = (childMerged.metrics.callout || 0) + (childOcc.metrics.callout || 0);
        childMerged.metrics.soqlTimeMs = (childMerged.metrics.soqlTimeMs || 0) + (childOcc.metrics.soqlTimeMs || 0);
        childMerged.metrics.dmlTimeMs = (childMerged.metrics.dmlTimeMs || 0) + (childOcc.metrics.dmlTimeMs || 0);
        childMerged.metrics.calloutTimeMs = (childMerged.metrics.calloutTimeMs || 0) + (childOcc.metrics.calloutTimeMs || 0);
        stack.push({ occ: childOcc, merged: childMerged });
      }
    }
  }

  const mergedRoots = [bySig.get(signature)!].filter(Boolean) as CallTreeNode[];
  const all = new Map<string, CallTreeNode>(Array.from(bySig.entries()).map(([k, v]) => [v.id, v]));
  const totals = { totalTimeMs: mergedRoots.reduce((m, r) => m + r.metrics.totalTimeMs, 0) };
  // Build backlinks for backtraces navigation
  for (const n of bySig.values()) for (const c of n.children) (c.parents ||= []).push(n);
  return { roots: mergedRoots, all, bySignature: model.bySignature, parentsBySignature: model.parentsBySignature, totals };
}

export function invertForSignature(model: CallTreeModel, signature: string): CallTreeModel {
  // Build callers tree (backtraces) for the given signature using the parentsBySignature index.
  const seen = new Set<string>();
  const makeNode = (sig: string): CallTreeNode => {
    const sample = (model.bySignature.get(sig) || [])[0];
    const className = sample?.ref.className || sig.split('#')[0] || '';
    const method = sample?.ref.method || sig.split('#')[1] || '';
    const n: CallTreeNode = {
      id: `back:${sig}`,
      ref: { className, method, label: `${className}.${method}` },
      children: [],
      metrics: { totalTimeMs: 0, ownTimeMs: 0 }
    };
    // Aggregate totals from occurrences
    for (const occ of model.bySignature.get(sig) || []) {
      n.metrics.totalTimeMs += occ.metrics.totalTimeMs;
      n.metrics.ownTimeMs += occ.metrics.ownTimeMs;
    }
    return n;
  };
  const root = makeNode(signature);
  const nodes = new Map<string, CallTreeNode>([[signature, root]]);
  const queue: string[] = [signature];
  seen.add(signature);
  while (queue.length) {
    const cur = queue.shift()!;
    const parents = Array.from(model.parentsBySignature.get(cur) || []);
    for (const p of parents) {
      let pn = nodes.get(p);
      if (!pn) {
        pn = makeNode(p);
        nodes.set(p, pn);
      }
      // Link parent -> child (inverted: callers above)
      pn.children.push(nodes.get(cur)!);
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  const roots = [root];
  const all = new Map<string, CallTreeNode>(Array.from(nodes.values()).map(n => [n.id, n]));
  const totals = { totalTimeMs: root.metrics.totalTimeMs };
  return { roots, all, bySignature: model.bySignature, parentsBySignature: model.parentsBySignature, totals };
}

export function scopeToOccurrence(model: CallTreeModel, nodeId: string): CallTreeModel {
  const src = model.all.get(nodeId);
  if (!src) return model;
  const all = new Map<string, CallTreeNode>();
  const clone = (n: CallTreeNode): CallTreeNode => {
    const m: CallTreeNode = {
      id: n.id,
      ref: { ...n.ref },
      children: [],
      metrics: { ...n.metrics },
      start: n.start,
      end: n.end,
      depth: 0,
      actor: n.actor
    };
    all.set(m.id, m);
    for (const c of n.children) {
      const cc = clone(c);
      m.children.push(cc);
      (cc.parents ||= []).push(m);
    }
    return m;
  };
  const root = clone(src);
  const roots = [root];
  const totals = { totalTimeMs: root.metrics.totalTimeMs };
  return { roots, all, bySignature: model.bySignature, parentsBySignature: model.parentsBySignature, totals };
}
