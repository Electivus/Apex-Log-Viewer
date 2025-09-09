import assert from 'assert/strict';
import { parseApexLogToGraph } from '../shared/apexLogParser/graph';

suite('parseApexLogToGraph', () => {
  test('handles incomplete logs gracefully', () => {
    const log = [
      '64.0 APEX_CODE,FINEST;',
      '12:00:00.000 (0)|CODE_UNIT_STARTED|[EXTERNAL]|MyTrigger on Account trigger event BeforeInsert',
      '12:00:00.001 (1)|METHOD_ENTRY|MyClass.myMethod'
    ].join('\n');

    const graph = parseApexLogToGraph(log);

    const ids = graph.nodes.map(n => n.id);
    assert(ids.includes('Trigger:MyTrigger'));
    assert(ids.includes('Class:MyClass'));

    const codes = (graph.issues || []).map(i => i.code);
    assert(codes.includes('frames.unit.unclosed'));
    assert(codes.includes('frames.method.unclosed'));
    assert(codes.includes('events.methods.unbalanced'));
  });
});
