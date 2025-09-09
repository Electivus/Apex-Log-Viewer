import type { GraphEdge, GraphNode, LogLevels, SequenceEvent } from './types';

export function nodeId(kind: GraphNode['kind'], name: string): string {
  return `${kind}:${name}`;
}

export function upsertNode(
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

export function incEdge(edgesByKey: Map<string, GraphEdge>, from: string, to: string) {
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

export function addSequenceEvent(sequence: SequenceEvent[], event: SequenceEvent) {
  sequence.push(event);
}
