import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeLogLine, decodeLogLineRanges, decodeLogText, type LogTextRange } from '../src/logText.ts';

function decodedHighlights(line: string, ranges: LogTextRange[]) {
  const decoded = decodeLogLineRanges(line, ranges);
  return { text: decoded.text, highlights: decoded.ranges.map(([start, end]) => decoded.text.slice(start, end)) };
}

test('decodeLogText changes only the escaped pipe', () => {
  assert.equal(decodeLogText('a&#124;b&#124;c &amp;#124; &#125; &'), 'a|b|c &amp;#124; &#125; &');
});

test('decodeLogLine leaves the Execute Anonymous source as written', () => {
  const source = "Execute Anonymous: System.debug('a&#124;b');";

  assert.equal(decodeLogLine(source), source);
  assert.equal(decodeLogLine('12:00:00.0 (1)|USER_DEBUG|a&#124;b'), '12:00:00.0 (1)|USER_DEBUG|a|b');
});

test('decodeLogLineRanges keeps the ranges of a line with nothing to decode', () => {
  assert.deepEqual(decodeLogLineRanges('plain|text', [[0, 5]]), { text: 'plain|text', ranges: [[0, 5]] });
});

test('decodeLogLineRanges keeps ranges on the Execute Anonymous source', () => {
  const source = "Execute Anonymous: 'a&#124;b'";

  assert.deepEqual(decodeLogLineRanges(source, [[20, 28]]), { text: source, ranges: [[20, 28]] });
});

test('decodeLogLineRanges moves ranges that follow, hold or touch an escaped pipe', () => {
  const line = 'a&#124;b&#124;c';
  const cases: Array<[LogTextRange, string]> = [
    [[0, 1], 'a'],
    [[1, 7], '|'],
    [[0, 8], 'a|b'],
    [[7, 8], 'b'],
    [[14, 15], 'c'],
    [[0, 15], 'a|b|c'],
    [[3, 6], '|'],
    [[2, 3], '|'],
    [[6, 8], '|b'],
    [[0, 2], 'a|'],
    [[6, 9], '|b|']
  ];

  for (const [range, highlight] of cases) {
    assert.deepEqual(decodedHighlights(line, [range]), { text: 'a|b|c', highlights: [highlight] }, `range ${range}`);
  }
});

test('decodeLogLineRanges handles an escaped pipe at either end of the line', () => {
  assert.deepEqual(decodedHighlights('&#124;x&#124;', [[0, 6]]), { text: '|x|', highlights: ['|'] });
  assert.deepEqual(decodedHighlights('&#124;x&#124;', [[7, 13]]), { text: '|x|', highlights: ['|'] });
  assert.deepEqual(decodedHighlights('&#124;x&#124;', [[0, 13]]), { text: '|x|', highlights: ['|x|'] });
});
