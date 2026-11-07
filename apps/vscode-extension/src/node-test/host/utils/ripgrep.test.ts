import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rgPath } from '@vscode/ripgrep';

import { buildLogSearchSnippet } from '../../../host/utils/logSearchSnippet';
import { buildRipgrepFileSearchArgs, buildRipgrepSearchArgs, ripgrepSearchFiles } from '../../../host/utils/ripgrep';

suite('ripgrep log search', () => {
  test('searches the managed apexlogs cache even when gitignored', () => {
    const args = buildRipgrepSearchArgs('STATEMENT_EXECUT');

    assert.ok(args.includes('--no-ignore'));
    assert.deepEqual(args.slice(-3), ['--', 'STATEMENT_EXECUT', '.']);
  });

  test('searches only lifecycle-approved local files', () => {
    const files = ['/workspace/apexlogs/orgs/one/logs/2026-07-20/one.log', '/workspace/path with spaces/two.log'];
    const args = buildRipgrepFileSearchArgs('FATAL_ERROR', files);

    assert.deepEqual(args.slice(-4), ['--', 'FATAL_ERROR', ...files]);
  });
});

suite('ripgrep log search with the real binary', () => {
  const LOG_LINES = [
    '66.0 APEX_CODE,FINEST;APEX_PROFILING,INFO',
    "Execute Anonymous: System.debug('ALV_ECHO&#124;as_written');",
    '10:41:42.0 (1044484)|USER_DEBUG|[2]|ERROR|ação✓ ALV_RUNTIME&#124;status=FAILED&#124;reason=x',
    '10:41:42.0 (1044485)|USER_DEBUG|[3]|DEBUG|plain'
  ];
  const originalPath = process.env.PATH;
  let dir: string;
  let logPath: string;

  suiteSetup(async () => {
    process.env.PATH = `${path.dirname(rgPath)}${path.delimiter}${originalPath}`;
    dir = await mkdtemp(path.join(tmpdir(), 'alv-ripgrep-'));
    logPath = path.join(dir, 'real.log');
    await writeFile(logPath, `${LOG_LINES.join('\n')}\n`);
  });

  suiteTeardown(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });

  async function search(query: string, file = logPath) {
    return (await ripgrepSearchFiles(query, [file])).map(match => {
      const snippet = buildLogSearchSnippet(match);
      assert.ok(snippet, 'should build an excerpt');
      return { text: snippet.text, highlights: snippet.ranges.map(([start, end]) => snippet.text.slice(start, end)) };
    });
  }

  const EVENT_EXCERPT = '10:41:42.0 (1044484)|USER_DEBUG|[2]|ERROR|ação✓ ALV_RUNTIME|status=FAILED|reason=x';

  for (const [title, query, highlight] of [
    ['a `|` in the query finds `&#124;` in the log', 'ALV_RUNTIME|status', 'ALV_RUNTIME|status'],
    ['every `|` in the query finds `&#124;`', 'ALV_RUNTIME|status=FAILED|reason', 'ALV_RUNTIME|status=FAILED|reason'],
    ['`&#124;` in the query still finds itself', 'ALV_RUNTIME&#124;status', 'ALV_RUNTIME|status'],
    [
      'one query crosses a real `|` and an escaped one',
      'ERROR|ação✓ ALV_RUNTIME|status',
      'ERROR|ação✓ ALV_RUNTIME|status'
    ],
    ['the search ignores case', 'alv_runtime|STATUS', 'ALV_RUNTIME|status']
  ] as const) {
    test(title, async () => {
      assert.deepEqual(await search(query), [{ text: EVENT_EXCERPT, highlights: [highlight] }]);
    });
  }

  test('a match in the Execute Anonymous source stays as written', async () => {
    const source = "Execute Anonymous: System.debug('ALV_ECHO&#124;as_written');";

    for (const query of ['ALV_ECHO&#124;as_written', 'ALV_ECHO|as_written']) {
      assert.deepEqual(await search(query), [{ text: source, highlights: ['ALV_ECHO&#124;as_written'] }], query);
    }
  });

  test('a real `|` in the log still matches a `|` in the query', async () => {
    const [match] = await search('USER_DEBUG|[2]|ERROR');

    assert.deepEqual(match?.highlights, ['USER_DEBUG|[2]|ERROR']);
  });

  test('`&#124;` in the query does not match a real `|` in the log', async () => {
    const file = path.join(dir, 'real-pipes-only.log');
    await writeFile(file, '10:41:42.0 (1)|USER_DEBUG|[3]|DEBUG|plain\n');

    assert.deepEqual(await search('&#124;', file), []);
  });

  test('finds nothing when the text around the `|` differs', async () => {
    assert.deepEqual(await search('ALV_RUNTIME|missing'), []);
  });

  test('takes every punctuation character in the query as itself', async () => {
    const punctuation = Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)).filter(
      char => !/[0-9A-Za-z]/.test(char)
    );
    for (const char of punctuation) {
      const line = `Ax${char}yB`;
      const file = path.join(dir, `punctuation-${char.charCodeAt(0)}.log`);
      await writeFile(file, `AxyB\nAxxyB\nAxzyB\n${line}\n`);

      const [match] = await search(line, file);

      assert.deepEqual(match?.highlights, [line], `query ${line}`);
    }
  });
});
