import assert from 'assert/strict';
import { nodeId, upsertNode, incEdge, addSequenceEvent } from '../shared/apexLogParser/graph';
import type { GraphNode, GraphEdge, SequenceEvent } from '../shared/apexLogParser/types';

suite('graph utilities', () => {
  test('upsertNode avoids duplicates', () => {
    const map = new Map<string, GraphNode>();
    const a = upsertNode(map, 'Class', 'MyClass');
    const b = upsertNode(map, 'Class', 'MyClass');
    assert.equal(map.size, 1);
    assert.equal(a, b);
  });

  test('addSequenceEvent handles missing from id', () => {
    const seq: SequenceEvent[] = [];
    addSequenceEvent(seq, { to: nodeId('Class', 'MyClass'), label: 'test' });
    assert.equal(seq.length, 1);
    assert.equal(seq[0]!.from, undefined);
    assert.equal(seq[0]!.to, nodeId('Class', 'MyClass'));
  });

  test('incEdge increments counts and ignores self loops', () => {
    const edges = new Map<string, GraphEdge>();
    incEdge(edges, 'A', 'B');
    incEdge(edges, 'A', 'B');
    incEdge(edges, 'A', 'A');
    assert.equal(edges.size, 1);
    assert.equal(edges.get('A|B')!.count, 2);
  });
});
