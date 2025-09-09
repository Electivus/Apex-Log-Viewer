import assert from 'assert/strict';
import { addSequenceEvent, incEdge, nodeId, upsertNode } from '../../shared/apexLogParser/graph';
import type { GraphEdge, GraphNode } from '../../shared/apexLogParser/types';

suite('graph utilities', () => {
  test('nodeId composes kind and name', () => {
    assert.equal(nodeId('Class', 'MyClass'), 'Class:MyClass');
  });

  test('upsertNode creates and memoizes nodes', () => {
    const nodes = new Map<string, GraphNode>();
    const n1 = upsertNode(nodes, 'Class', 'Svc', { APEX_CODE: 'FINEST' });
    const n2 = upsertNode(nodes, 'Class', 'Svc', { APEX_CODE: 'DEBUG' });
    assert.equal(n1, n2);
    assert.equal(nodes.size, 1);
    assert.equal(n1.id, 'Class:Svc');
    assert.equal(n1.label, 'Svc');
  });

  test('incEdge adds and increments; ignores self loops', () => {
    const edges = new Map<string, GraphEdge>();
    const a = 'Class:A';
    const b = 'Class:B';
    assert.equal(incEdge(edges, a, a), undefined); // self-loop ignored
    const e1 = incEdge(edges, a, b)!;
    assert.equal(e1.count, 1);
    const e2 = incEdge(edges, a, b)!;
    assert.equal(e2.count, 2);
    assert.equal(edges.size, 1);
  });

  test('addSequenceEvent pushes even when owner is missing (incomplete log)', () => {
    const sequence: any[] = [];
    addSequenceEvent(sequence, { to: 'Class:Target', label: 'METHOD_ENTRY' });
    assert.equal(sequence.length, 1);
    assert.equal(sequence[0].from, undefined);
    assert.equal(sequence[0].to, 'Class:Target');
  });
});

