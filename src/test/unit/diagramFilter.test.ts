import assert from 'assert/strict';
import type { NestedFrame } from '../../shared/apexLogParser/types';
import { filterAndCollapse } from '../../webview/utils/diagramFilter';

suite('filterAndCollapse (diagram filter)', () => {
  test('hides frames from hidden actors', () => {
    const frames: NestedFrame[] = [
      { actor: 'Class:Logger', label: 'Logger.log(String)', start: 0, end: 1, depth: 1, kind: 'method' },
      { actor: 'Class:Service', label: 'Service.run()', start: 1, end: 2, depth: 1, kind: 'method' }
    ];
    const out = filterAndCollapse(frames, false, false, new Set(['Class:Logger']));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.actor, 'Class:Service');
  });

  test('hides System frames when hideSystem=true', () => {
    const frames: NestedFrame[] = [
      {
        actor: 'Class:System.String',
        label: 'System.String.join(List<String>)',
        start: 0,
        end: 1,
        depth: 1,
        kind: 'method'
      },
      { actor: 'Class:MyApp', label: 'MyApp.exec()', start: 1, end: 2, depth: 1, kind: 'method' }
    ];
    const out = filterAndCollapse(frames, true, false, new Set());
    assert.equal(out.length, 1);
    assert.equal(out[0]!.actor, 'Class:MyApp');
  });

  test('collapses consecutive repeats', () => {
    const frames: NestedFrame[] = [
      { actor: 'Class:Svc', label: 'Svc.work()', start: 0, end: 1, depth: 1, kind: 'method' },
      { actor: 'Class:Svc', label: 'Svc.work()', start: 1, end: 2, depth: 1, kind: 'method' }
    ];
    const out = filterAndCollapse(frames, false, true, new Set());
    assert.equal(out.length, 1);
    assert.equal(out[0]!.actor, 'Class:Svc');
    assert.equal((out[0] as any).count, 2);
    assert.equal(out[0]!.end, 2);
  });
});
