import assert from 'assert/strict';
import { parseApexLogToGraph } from '../../shared/apexLogParser/graph';

suite('parseApexLogToGraph', () => {
  test('handles missing exits gracefully', () => {
    const log = [
      '12:00:00.000 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01p|MyTrigger',
      '12:00:00.100 (100)|METHOD_ENTRY|[EXTERNAL]|01p|MyClass|MyClass.doWork'
    ].join('\n');
    const graph = parseApexLogToGraph(log);
    assert.ok(graph.nodes.length > 0);
    const codes = (graph.issues || []).map(i => i.code);
    assert(codes.includes('frames.unit.unclosed'));
    assert(codes.includes('frames.method.unclosed'));
  });
});
