import assert from 'node:assert/strict';

import { buildLogSearchSnippet } from '../../../host/utils/logSearchSnippet';
import type { RipgrepMatch } from '../../../host/utils/ripgrep';

const EVENT_LINE = '10:41:42.0 (1044484)|USER_DEBUG|[2]|ERROR|ação✓ ALV_RUNTIME_1794&#124;status=FAILED&#124;reason=x';
const DECODED_EVENT_LINE = '10:41:42.0 (1044484)|USER_DEBUG|[2]|ERROR|ação✓ ALV_RUNTIME_1794|status=FAILED|reason=x';
const SOURCE_ECHO_LINE = "Execute Anonymous: System.debug('ALV_ECHO_1794&#124;as_written');";

function ripgrepMatch(line: string, ...matched: string[]): RipgrepMatch {
  let from = 0;
  const submatches = matched.map(text => {
    const at = line.indexOf(text, from);
    assert.notEqual(at, -1, `the test line does not hold ${text}`);
    from = at + text.length;
    return { start: Buffer.byteLength(line.slice(0, at)), end: Buffer.byteLength(line.slice(0, from)) };
  });
  return { filePath: '/workspace/apexlogs/07L.log', lineText: `${line}\n`, submatches };
}

function excerpt(line: string, ...matched: string[]) {
  const snippet = buildLogSearchSnippet(ripgrepMatch(line, ...matched));
  assert.ok(snippet, 'should build an excerpt');
  return { text: snippet.text, highlights: snippet.ranges.map(([start, end]) => snippet.text.slice(start, end)) };
}

suite('Logs panel search excerpt', () => {
  test('shows `|` for each `&#124;` and highlights the match', () => {
    assert.deepEqual(excerpt(EVENT_LINE, 'ALV_RUNTIME_1794'), {
      text: DECODED_EVENT_LINE,
      highlights: ['ALV_RUNTIME_1794']
    });
  });

  test('keeps the highlight on a match that follows escaped pipes', () => {
    assert.deepEqual(excerpt(EVENT_LINE, 'reason=x').highlights, ['reason=x']);
  });

  test('highlights the decoded form of a match that holds an escaped pipe', () => {
    assert.deepEqual(excerpt(EVENT_LINE, 'ALV_RUNTIME_1794&#124;status').highlights, ['ALV_RUNTIME_1794|status']);
  });

  test('highlights the `|` when the match is the escaped form alone', () => {
    const { text, highlights } = excerpt(EVENT_LINE, '&#124;', '&#124;');

    assert.ok(text.endsWith('ALV_RUNTIME_1794|status=FAILED|reason=x'), text);
    assert.deepEqual(highlights, ['|', '|']);
  });

  test('highlights the `|` when the match holds part of the escaped form', () => {
    assert.deepEqual(excerpt(EVENT_LINE, '124;status').highlights, ['|status']);
    assert.deepEqual(excerpt(EVENT_LINE, '1794&#1').highlights, ['1794|']);
  });

  test('keeps the Execute Anonymous source as written', () => {
    assert.deepEqual(excerpt(SOURCE_ECHO_LINE, 'ALV_ECHO_1794&#124;as_written'), {
      text: SOURCE_ECHO_LINE,
      highlights: ['ALV_ECHO_1794&#124;as_written']
    });
  });

  test('measures the context around the match on the decoded text', () => {
    const line = `${'x&#124;'.repeat(40)}NEEDLE${'&#124;y'.repeat(40)}`;

    assert.deepEqual(excerpt(line, 'NEEDLE'), {
      text: `...${'x|'.repeat(30)}NEEDLE${'|y'.repeat(30)}...`,
      highlights: ['NEEDLE']
    });
  });

  test('reads the byte offsets of a line with no escaped pipe', () => {
    assert.deepEqual(excerpt('São Paulo ✓ 𝒳 needle', 'needle'), {
      text: 'São Paulo ✓ 𝒳 needle',
      highlights: ['needle']
    });
  });
});
