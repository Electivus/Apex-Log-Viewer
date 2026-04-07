const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shellQuote = require('shell-quote');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function workflowFiles() {
  return fs
    .readdirSync(path.join(repoRoot, '.github', 'workflows'))
    .filter(name => name.endsWith('.yml'))
    .map(name => path.posix.join('.github/workflows', name));
}

function usesRefs(relativePath) {
  return Array.from(
    read(relativePath).matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+?)(?:\s+#.*)?\s*$/gm),
    match => match[1]
  );
}

function runCommandLines(workflow) {
  const commands = [];
  const lines = workflow.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const match = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const runValue = match[2].trimEnd();
    if (/^[>|][+-]?$/.test(runValue.trim())) {
      const blockLines = [];

      for (index += 1; index < lines.length; index += 1) {
        const blockLine = lines[index].replace(/\r$/, '');
        const blockIndent = blockLine.match(/^\s*/)?.[0].length ?? 0;
        const trimmedBlockLine = blockLine.trimEnd();

        if (trimmedBlockLine.trim() !== '' && blockIndent <= indent) {
          index -= 1;
          break;
        }
        blockLines.push(blockLine);
      }
      commands.push(...commandsFromRunValue(blockLines.join('\n')));
      continue;
    }

    commands.push(...commandsFromRunValue(runValue.trim()));
  }

  return commands;
}

function commandIndexes(workflow, matcher) {
  return runCommandLines(workflow)
    .map((command, index) => (matcher(command) ? index : -1))
    .filter(index => index !== -1);
}

function shellCommandSegments(command) {
  return command
    .split(/&&|\|\||;/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function heredocTerminator(command) {
  const tokens = parseShellTokens(command);
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index]?.op === '<' && tokens[index + 1]?.op === '<' && typeof tokens[index + 2] === 'string') {
      return tokens[index + 2].replace(/^-/, '');
    }
  }
  return undefined;
}

function parseShellTokens(segment) {
  const sanitized = segment.replace(/\$\{\{.*?\}\}/g, 'GITHUB_EXPR');
  try {
    return shellQuote.parse(sanitized);
  } catch {
    return [sanitized];
  }
}

function normalizeCommandSegment(segment) {
  const tokens = parseShellTokens(segment);
  let index = 0;
  const shellWrappers = new Set(['env', 'time', 'command', 'sudo']);

  while (tokens[index]?.op === '(') {
    index += 1;
  }

  while (typeof tokens[index] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index += 1;
  }

  while (typeof tokens[index] === 'string' && shellWrappers.has(tokens[index])) {
    const wrapper = tokens[index];
    index += 1;
    while (typeof tokens[index] === 'string' && tokens[index].startsWith('-')) {
      index += 1;
    }
    if (wrapper === 'env') {
      while (typeof tokens[index] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
        index += 1;
      }
    }
  }

  return tokens.slice(index).filter(token => typeof token === 'string').join(' ');
}

function commandsFromRunValue(runValue) {
  if (typeof runValue !== 'string') {
    return [];
  }

  const commands = [];
  let continuedCommand = '';
  let heredocDelimiter;

  for (const rawLine of runValue.split('\n')) {
    const trimmedLine = rawLine.replace(/\r$/, '').trim();
    if (heredocDelimiter) {
      if (trimmedLine === heredocDelimiter) {
        heredocDelimiter = undefined;
      }
      continue;
    }

    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    const nextCommand = continuedCommand ? `${continuedCommand} ${trimmedLine}` : trimmedLine;
    if (nextCommand.endsWith('\\')) {
      continuedCommand = nextCommand.slice(0, -1).trimEnd();
      continue;
    }

    commands.push(nextCommand);
    heredocDelimiter = heredocTerminator(nextCommand);
    continuedCommand = '';
  }

  if (continuedCommand) {
    commands.push(continuedCommand);
  }

  return commands;
}

function workflowJobs(workflow) {
  const parsed = yaml.parse(workflow);
  if (!parsed?.jobs || typeof parsed.jobs !== 'object') {
    return [];
  }

  return Object.entries(parsed.jobs)
    .filter(([, job]) => job && typeof job === 'object')
    .map(([jobName, job]) => ({
      jobName,
      steps: Array.isArray(job.steps) ? job.steps : []
    }));
}

function jobCommandLines(job) {
  return job.steps.flatMap(step => commandsFromRunValue(step?.run));
}

function commandIndexesInCommands(commands, matcher) {
  return commands
    .map((command, index) => (matcher(command) ? index : -1))
    .filter(index => index !== -1);
}

function npmCiProvenanceViolations(workflow) {
  const violations = [];

  for (const job of workflowJobs(workflow)) {
    const commands = jobCommandLines(job);
    const provenanceChecks = commandIndexesInCommands(commands, isProvenanceCheckCommand);
    const npmInstalls = commandIndexesInCommands(commands, isNpmCiCommand);

    let matchedChecks = 0;
    for (let installIndex = 0; installIndex < npmInstalls.length; installIndex += 1) {
      if (matchedChecks < provenanceChecks.length && provenanceChecks[matchedChecks] < npmInstalls[installIndex]) {
        matchedChecks += 1;
        continue;
      }

      violations.push({
        jobName: job.jobName,
        installIndex
      });
    }
  }

  return violations;
}

function isProvenanceCheckCommand(command) {
  return shellCommandSegments(command).some(segment =>
    /^node scripts\/check-dependency-sources\.mjs(?=$|[\s|)])/.test(normalizeCommandSegment(segment))
  );
}

function isNpmCiCommand(command) {
  return shellCommandSegments(command).some(segment => /^npm ci(?=$|[\s|)])/.test(normalizeCommandSegment(segment)));
}

test('usesRefs matches dash-prefixed workflow steps', () => {
  assert.deepEqual(usesRefs('.github/workflows/semantic-pr.yml'), [
    'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50'
  ]);
});

test('usesRefs keeps pinned refs when the line has an inline comment', () => {
  const tempDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-repo-security-'));
  const fixturePath = path.join(tempDir, 'inline-comment.yml');
  const relativeFixturePath = path.relative(repoRoot, fixturePath);

  try {
    fs.writeFileSync(
      fixturePath,
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # pinned'
      ].join('\n')
    );

    assert.deepEqual(usesRefs(relativeFixturePath), [
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd'
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('all workflow uses refs are pinned to full commit SHAs', () => {
  for (const workflowPath of workflowFiles()) {
    for (const ref of usesRefs(workflowPath)) {
      if (ref.startsWith('./')) {
        continue;
      }
      assert.match(
        ref,
        /@[0-9a-f]{40}$/,
        `${workflowPath} should pin ${ref} to a full commit SHA`
      );
    }
  }
});

test('dependency review workflow exists and is wired to pull_request', () => {
  const workflow = read('.github/workflows/dependency-review.yml');
  assert.match(workflow, /^name:\s+Dependency Review$/m);
  assert.match(workflow, /^on:\s*[\r\n]+  pull_request:/m);
  assert.match(workflow, /uses:\s+actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(workflow, /config-file:\s+\.\/\.github\/dependency-review-config\.yml/);
});

test('CI workflow enforces dependency provenance and npm signature verification', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /\bnode scripts\/check-dependency-sources\.mjs\b/);
  assert.match(workflow, /\bnpm run security:npm-signatures\b/);
});

test('npm ci provenance detection handles multiline run blocks', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          node scripts/check-dependency-sources.mjs',
    '          npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(
    workflow,
    isProvenanceCheckCommand
  );
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 1);
  assert.equal(npmInstalls.length, 1);
  assert.ok(provenanceChecks[0] < npmInstalls[0]);
});

test('npm ci provenance detection handles inline command chains', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: echo prep && npm ci'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles shell operators without surrounding spaces', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm ci&&npm run test'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('commented workflow lines do not count as provenance commands', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          # node scripts/check-dependency-sources.mjs',
    '          npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(
    workflow,
    isProvenanceCheckCommand
  );
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 0);
  assert.equal(npmInstalls.length, 1);
});

test('echoed provenance command text does not count as validation', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          echo \"node scripts/check-dependency-sources.mjs\"',
    '          npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(workflow, isProvenanceCheckCommand);
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 0);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles line continuations in run blocks', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          npm \\',
    '          ci'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('echoed heredoc payload does not count as provenance validation', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    "          cat <<'EOF'",
    '          node scripts/check-dependency-sources.mjs',
    '          EOF',
    '          npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(workflow, isProvenanceCheckCommand);
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 0);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles shell-prefixed installs', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: FOO=1 npm ci'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles shell-builtin-prefixed installs', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: command npm ci'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles sudo-prefixed installs', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: sudo npm ci'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('dependency provenance validation is enforced within each job', () => {
  const workflow = [
    'jobs:',
    '  validate:',
    '    steps:',
    '      - run: node scripts/check-dependency-sources.mjs',
    '  install:',
    '    steps:',
    '      - run: npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'install',
      installIndex: 0
    }
  ]);
});

test('every workflow npm ci step is preceded by dependency provenance validation', () => {
  for (const workflowPath of workflowFiles()) {
    const workflow = read(workflowPath);
    const violations = npmCiProvenanceViolations(workflow);

    assert.deepEqual(
      violations,
      [],
      `${workflowPath} should validate dependency provenance before every npm ci step in the same job`
    );
  }
});

test('package.json declares shell-quote for repo-security tests', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(
    String(pkg.devDependencies?.['shell-quote'] || ''),
    /^\S+$/,
    'package.json should declare shell-quote explicitly'
  );
});

test('package.json runs repo-security and dependency-source checks in the default script lane', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.scripts?.['test:scripts'] || ''), /\bscripts\/repo-security\.test\.js\b/);
  assert.match(String(pkg.scripts?.['test:scripts'] || ''), /\bnode scripts\/check-dependency-sources\.mjs\b/);
  assert.equal(pkg.scripts?.['security:dependency-sources'], 'node scripts/check-dependency-sources.mjs');
});

test('CODEOWNERS covers workflows, manifests, lockfiles, and release metadata', () => {
  const owners = read('.github/CODEOWNERS');
  for (const expected of [
    '/.github/workflows/ @Electivus/maintainers',
    '/.github/dependency-review-config.yml @Electivus/maintainers',
    '/package.json @Electivus/maintainers',
    '/package-lock.json @Electivus/maintainers',
    '/Cargo.toml @Electivus/maintainers',
    '/Cargo.lock @Electivus/maintainers',
    '/deny.toml @Electivus/maintainers',
    '/config/runtime-bundle.json @Electivus/maintainers',
    '/apps/vscode-extension/scripts/copy-tree-sitter-runtime.mjs @Electivus/maintainers',
    '/scripts/fetch-runtime-release.mjs @Electivus/maintainers'
  ]) {
    assert.match(owners, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('Rust workspace keeps a checked-in Cargo.lock and cargo-deny config', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'Cargo.lock')), true, 'Cargo.lock should be checked in');
  const denyToml = read('deny.toml');
  assert.match(denyToml, /^\[sources\]$/m);
  assert.match(denyToml, /^unknown-registry = "deny"$/m);
  assert.match(denyToml, /^unknown-git = "deny"$/m);
});

test('Rust supply-chain workflow runs cargo-deny on PRs and main pushes', () => {
  const workflow = read('.github/workflows/rust-supply-chain.yml');
  assert.match(workflow, /^name:\s+Rust Supply Chain$/m);
  assert.match(workflow, /^on:\s*[\r\n]+  pull_request:\s*[\r\n]+  push:\s*[\r\n]+    branches:\s*[\r\n]+      - main/m);
  assert.match(workflow, /\bcargo deny check advisories bans licenses sources\b/);
});
