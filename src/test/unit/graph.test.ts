import { strict as assert } from 'assert';
import { addSequenceEvent, nodeId, upsertNode } from '../../shared/apexLogParser/graph';
import type { GraphNode, SequenceEvent } from '../../shared/apexLogParser/types';

suite('graph helpers', () => {
  test('upserts nodes without duplicates', () => {
    const map = new Map<string, GraphNode>();
    const first = upsertNode(map, 'Class', 'MyClass');
    const second = upsertNode(map, 'Class', 'MyClass');
    assert.equal(map.size, 1);
    assert.strictEqual(first, second);
  });

  test('adds sequence events with optional from field', () => {
    const seq: SequenceEvent[] = [];
    addSequenceEvent(seq, { to: nodeId('Class', 'MyClass'), label: 'start' });
    assert.deepEqual(seq, [{ to: 'Class:MyClass', label: 'start' }]);
  });
});
