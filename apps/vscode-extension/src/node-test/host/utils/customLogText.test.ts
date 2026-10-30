import assert from 'node:assert/strict';

import { reindentJson } from '../../../host/utils/customLogText';

suite('Custom Logs text helpers', () => {
  test('lays JSON out over lines and keeps empty containers compact', () => {
    assert.equal(
      reindentJson('{"a":1,"b":[1,2,{"c":null}],"d":{},"e":[ ]}'),
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    1,',
        '    2,',
        '    {',
        '      "c": null',
        '    }',
        '  ],',
        '  "d": {},',
        '  "e": []',
        '}'
      ].join('\n')
    );
  });

  test('changes whitespace only: every number and string keeps its spelling', () => {
    const source = '{"big":12345678901234567890,"exp":1e3,"zero":1.0,"neg":-0.50,"s":"a,b:{c}\\"d\\\\","u":"\\u00e9 "}';

    const laidOut = reindentJson(source);

    assert.equal(laidOut.replace(/\n\s*/g, '').replace(/: /g, ':'), source);
    assert.ok(laidOut.includes('12345678901234567890'));
    assert.ok(laidOut.includes('1e3'));
    assert.ok(laidOut.includes('1.0'));
    assert.deepEqual(JSON.parse(laidOut), JSON.parse(source));
  });

  test('is idempotent', () => {
    const once = reindentJson('{"a":[1,{"b":2}]}');

    assert.equal(reindentJson(once), once);
  });
});
