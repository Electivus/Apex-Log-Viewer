import assert from 'node:assert/strict';

import { detectCustomLogTextFormat, reindentJson } from '../../../host/utils/customLogText';

suite('Custom Logs text helpers', () => {
  test('recognizes a JSON object or array and nothing else', () => {
    assert.equal(detectCustomLogTextFormat('{"a":1}'), 'json');
    assert.equal(detectCustomLogTextFormat('  [1, 2]\n'), 'json');
    assert.equal(detectCustomLogTextFormat('{"a":'), 'text');
    assert.equal(detectCustomLogTextFormat('42'), 'text');
    assert.equal(detectCustomLogTextFormat('"quoted"'), 'text');
    assert.equal(detectCustomLogTextFormat('{not json}'), 'text');
    assert.equal(detectCustomLogTextFormat(''), 'text');
  });

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
