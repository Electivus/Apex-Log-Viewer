const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { rgPath } = require('@vscode/ripgrep');

test('real ripgrep finds scoped evidence in an ignored corpus with legacy duplicates and spaces', async t => {
  const { materializeDebugCorpus, fixture } = await import(
    pathToFileURL(path.join(__dirname, 'agent-debug-fixtures.mjs')).href
  );
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'alv debug corpus '));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const corpus = await materializeDebugCorpus(workspace);
  const search = args => spawnSync(rgPath, args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(
    search(['-l', '-F', '--', fixture.clue, corpus.orgLogsRoot]).status,
    1,
    'ordinary rg misses ignored log files'
  );
  const canonical = search(['--no-ignore', '-l', '-0', '-F', '-g', '*.log', '--', fixture.clue, corpus.orgLogsRoot]);
  assert.equal(canonical.status, 0, canonical.stderr);
  const candidates = canonical.stdout.split('\0').filter(Boolean);
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every(file => file.startsWith(corpus.orgLogsRoot)));
  const legacy = search([
    '--no-ignore',
    '--max-depth',
    '1',
    '-l',
    '-0',
    '-F',
    '-g',
    `${fixture.org}_*.log`,
    '--',
    fixture.clue,
    corpus.apexlogsRoot
  ]);
  assert.equal(legacy.status, 0, legacy.stderr);
  const all = [...candidates, ...legacy.stdout.split('\0').filter(Boolean)];
  const ids = new Set(all.map(file => /(?:^|_)(07L\w+)\.log$/.exec(path.basename(file))[1]));
  assert.equal(all.length, 6);
  assert.equal(ids.size, 5);
  assert.ok(ids.has(corpus.legacyOnlyId));
  assert.equal(ids.has('07L000000000999AAA'), false);
  const evidence = search(['--no-ignore', '--json', '-F', '--', 'FATAL_ERROR', corpus.paths['functional-failure']]);
  const matches = evidence.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(item => item.type === 'match');
  assert.equal(matches[0].data.line_number, 6);
  assert.match(matches[0].data.lines.text, /NullPointerException/);
  const caught = search(['--no-ignore', '-n', '-F', '--', 'FATAL_ERROR', corpus.paths['caught-exception']]);
  assert.equal(caught.status, 1);
  const context = search([
    '--no-ignore',
    '-n',
    '-C',
    '2',
    '-F',
    '--',
    'EXCEPTION_THROWN',
    corpus.paths['caught-exception']
  ]);
  assert.match(context.stdout, /Handled timeout/);
  const missing = search(['--no-ignore', '-F', '--', 'absent', path.join(workspace, 'missing.log')]);
  assert.equal(missing.status, 2);
});
