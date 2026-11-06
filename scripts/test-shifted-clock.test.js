const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const runnerUrl = pathToFileURL(path.join(__dirname, 'test-shifted-clock.mjs')).href;

/** The TAP that `node --test --test-reporter=tap` writes for these test files, split into lines. */
function tapOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-shifted-tap-'));
  try {
    for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
    // Without NODE_TEST_CONTEXT the child is a runner of its own and writes TAP, not the parent's internal stream.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...Object.keys(files)], {
      cwd: dir,
      env,
      encoding: 'utf8'
    });
    return run.stdout.split('\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const notOk = (lines, name) =>
  lines.findIndex(line => line.trim().startsWith('not ok ') && line.endsWith(` - ${name}`));

test('a failed subtest shows its assertion message and location, and its parent shows nothing more', async () => {
  const { failureDetails } = await import(runnerUrl);
  const lines = tapOf({
    'abort.test.mjs': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('a process that aborts', async t => {",
      "  await t.test('after the connection dropped', () => {",
      "    assert.ok(1200 < 1000, 'the process lingered 1200 ms after the abort');",
      '  });',
      '});'
    ].join('\n')
  });

  const details = failureDetails(lines, notOk(lines, 'after the connection dropped'));
  assert.ok(details.includes("error: 'the process lingered 1200 ms after the abort'"), details.join('\n'));
  assert.ok(
    details.some(line => /^location: '.*abort\.test\.mjs:4:\d+'$/.test(line)),
    details.join('\n')
  );
  assert.ok(!details.some(line => line.startsWith('stack:') || line.startsWith('duration_ms:')), details.join('\n'));
  assert.deepEqual(failureDetails(lines, notOk(lines, 'a process that aborts')), []);
});

test('a multi-line assertion message is shown whole', async () => {
  const { failureDetails } = await import(runnerUrl);
  const lines = tapOf({
    'equal.test.mjs':
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('counts', () => assert.equal(0, 1));\n"
  });

  const details = failureDetails(lines, notOk(lines, 'counts'));
  const error = details.indexOf('error: |-');
  assert.ok(error !== -1, details.join('\n'));
  assert.ok(
    details.slice(error + 1).some(line => line.trim() === '0 !== 1'),
    details.join('\n')
  );
  assert.ok(details.includes('expected: 1') && details.includes('actual: 0'), details.join('\n'));
});

test('a long error message is cut at the line limit and says how much it left out', async () => {
  const { failureDetails } = await import(runnerUrl);
  const lines = [
    'not ok 1 - long',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    ...Array.from({ length: 10 }, (_, i) => `    line ${i}`),
    '  ...'
  ];

  assert.deepEqual(failureDetails(lines, 0, 4), [
    "failureType: 'testCodeFailure'",
    'error: |-',
    '  line 0',
    '  line 1',
    '… 8 more lines'
  ]);
});

test('a test file whose process died shows its exit code', async () => {
  const { failureDetails } = await import(runnerUrl);
  const lines = tapOf({
    'dies.test.mjs':
      "import test from 'node:test';\ntest('dies', async () => { await new Promise(r => setTimeout(r, 20)); process.exit(7); });\n"
  });

  const details = failureDetails(lines, notOk(lines, 'dies.test.mjs'));
  assert.ok(details.includes('exitCode: 7'), details.join('\n'));
  assert.ok(details.includes("error: 'test failed'"), details.join('\n'));
});

test('importing the runner does not start the sweep', () => {
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(runnerUrl)});`],
    {
      encoding: 'utf8',
      timeout: 10_000
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
});
