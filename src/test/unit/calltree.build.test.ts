import { strict as assert } from 'assert';
import type { NestedFrame } from '../../shared/apexLogParser/types';
import { buildCallTree } from '../../shared/callTree';

suite('callTree.build', () => {
  test('builds parent/child relations and own time', () => {
    const nested: NestedFrame[] = [
      // Unit frame (ignored by builder)
      {
        actor: 'Class:Top',
        label: 'Class.Top.start',
        start: 0,
        end: 5,
        depth: 0,
        kind: 'unit'
      },
      // Method A
      {
        actor: 'Class:Top',
        label: 'Top.entry()',
        start: 1,
        end: 5,
        depth: 1,
        kind: 'method',
        profile: { timeMs: 50 }
      },
      // Method B (child)
      {
        actor: 'Class:Foo',
        label: 'Foo.work()',
        start: 2,
        end: 4,
        depth: 2,
        kind: 'method',
        profile: { timeMs: 20 }
      }
    ];
    const model = buildCallTree(nested);
    assert.equal(model.roots.length, 1);
    const root = model.roots[0]!;
    assert.equal(root.ref.className, 'Top');
    assert.equal(root.children.length, 1);
    const child = root.children[0]!;
    assert.equal(child.ref.className, 'Foo');
    assert.equal(root.metrics.totalTimeMs, 50);
    assert.equal(child.metrics.totalTimeMs, 20);
    assert.equal(root.metrics.ownTimeMs, 30);
  });
});
