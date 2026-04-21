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

function shellCommandClauses(command) {
  const clauses = [];
  let current = [];
  let separatorBefore;

  for (const token of parseShellTokens(command)) {
    if (token?.op === '&&' || token?.op === '||' || token?.op === ';') {
      const segment = shellTokensToCommand(current);
      if (segment) {
        clauses.push({
          separatorAfter: token.op,
          separatorBefore,
          text: segment
        });
      }
      current = [];
      separatorBefore = token.op;
      continue;
    }

    current.push(token);
  }

  const trailingSegment = shellTokensToCommand(current);
  if (trailingSegment) {
    clauses.push({
      separatorAfter: undefined,
      separatorBefore,
      text: trailingSegment
    });
  }

  return clauses;
}

function shellTokensToCommand(tokens) {
  return tokens
    .map(token => {
      if (typeof token !== 'string') {
        return token?.op || '';
      }
      return /[\s;&|]/.test(token) ? JSON.stringify(token) : token;
    })
    .join(' ')
    .trim();
}

function shellCommandSegments(command) {
  return shellCommandClauses(command).map(clause => clause.text);
}

function heredocTerminator(command) {
  for (let index = 0; index < command.length - 1; index += 1) {
    const char = command[index];

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '\'' || char === '"') {
      const quote = char;
      index += 1;
      while (index < command.length) {
        if (command[index] === '\\' && quote === '"') {
          index += 2;
          continue;
        }
        if (command[index] === quote) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char !== '<' || command[index + 1] !== '<') {
      continue;
    }

    let delimiterIndex = index + 2;
    if (command[delimiterIndex] === '-') {
      delimiterIndex += 1;
    }
    while (/\s/.test(command[delimiterIndex] || '')) {
      delimiterIndex += 1;
    }
    if (delimiterIndex >= command.length) {
      return undefined;
    }

    const delimiterQuote = command[delimiterIndex];
    if (delimiterQuote === '\'' || delimiterQuote === '"') {
      const start = delimiterIndex + 1;
      delimiterIndex = start;
      while (delimiterIndex < command.length) {
        if (command[delimiterIndex] === '\\' && delimiterQuote === '"') {
          delimiterIndex += 2;
          continue;
        }
        if (command[delimiterIndex] === delimiterQuote) {
          return command.slice(start, delimiterIndex);
        }
        delimiterIndex += 1;
      }
      return undefined;
    }

    const match = /^[^\s;&|<>()]+/.exec(command.slice(delimiterIndex));
    return match?.[0];
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

function wrapperOptionConsumesNextValue(wrapper, option) {
  const optionsWithValues = {
    env: new Set([
      '-C',
      '--chdir',
      '-S',
      '--split-string',
      '-u',
      '--unset',
      '--block-signal',
      '--default-signal',
      '--ignore-signal'
    ]),
    sudo: new Set([
      '-C',
      '--close-from',
      '-D',
      '--chdir',
      '-g',
      '--group',
      '-h',
      '--host',
      '-p',
      '--prompt',
      '-R',
      '--chroot',
      '-r',
      '--role',
      '-t',
      '--type',
      '-u',
      '--user'
    ]),
    time: new Set(['-f', '--format', '-o', '--output']),
    ionice: new Set(['-c', '--class', '-n', '--classdata']),
    nice: new Set(['-n', '--adjustment']),
    stdbuf: new Set(['-e', '--error', '-i', '--input', '-o', '--output'])
  };
  const candidates = optionsWithValues[wrapper];
  if (!candidates) {
    return false;
  }

  for (const candidate of candidates) {
    if (option === candidate) {
      return true;
    }
    if (candidate.startsWith('--')) {
      continue;
    }
    if (option.startsWith(candidate) && option.length > candidate.length) {
      return false;
    }
  }

  return false;
}

function normalizedCommandTokens(segment) {
  const tokens = parseShellTokens(segment);
  let index = 0;
  const shellWrappers = new Set(['command', 'env', 'ionice', 'nice', 'nohup', 'setsid', 'stdbuf', 'sudo', 'time']);
  const shellControlKeywords = new Set(['then', 'do', 'else']);

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
      const option = tokens[index];
      index += 1;
      if (
        wrapperOptionConsumesNextValue(wrapper, option) &&
        typeof tokens[index] === 'string' &&
        !tokens[index].startsWith('-')
      ) {
        index += 1;
      }
    }
    if (wrapper === 'env') {
      while (typeof tokens[index] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
        index += 1;
      }
    }
  }

  while (typeof tokens[index] === 'string' && shellControlKeywords.has(tokens[index])) {
    index += 1;
  }

  return tokens.slice(index).filter(token => typeof token === 'string');
}

function normalizeCommandSegment(segment) {
  return normalizedCommandTokens(segment).join(' ');
}

function segmentErrexitMode(segment) {
  const tokens = normalizedCommandTokens(segment);
  if (tokens[0] !== 'set') {
    return undefined;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== 'string') {
      continue;
    }

    if (token === '-o' || token === '+o') {
      if (tokens[index + 1] === 'errexit') {
        return token === '-o';
      }
      continue;
    }

    if (token.startsWith('-') && token.slice(1).includes('e')) {
      return true;
    }

    if (token.startsWith('+') && token.slice(1).includes('e')) {
      return false;
    }
  }

  return undefined;
}

function shellInterpreterCommand(segment) {
  const tokens = normalizedCommandTokens(segment);
  const shell = tokens[0];
  if (typeof shell !== 'string') {
    return undefined;
  }

  const shellName = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || shell;
  if (!new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']).has(shellName)) {
    return undefined;
  }

  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (typeof token !== 'string' || !token.startsWith('-')) {
      continue;
    }
    if (token === '-c' || token === '--command' || token.slice(1).includes('c')) {
      return typeof tokens[index + 1] === 'string' ? tokens[index + 1] : undefined;
    }
  }

  return undefined;
}

function findBacktickCommandEnd(command, startIndex) {
  for (let index = startIndex; index < command.length; index += 1) {
    if (command[index] === '\\') {
      index += 1;
      continue;
    }
    if (command[index] === '`') {
      return index;
    }
  }

  return -1;
}

function commandSubstitutionOpenerLength(command, startIndex) {
  if (command[startIndex] !== '$') {
    return 0;
  }

  let index = startIndex + 1;
  while (/\s/.test(command[index] || '')) {
    index += 1;
  }

  return command[index] === '(' ? index - startIndex + 1 : 0;
}

function findCommandSubstitutionEnd(command, startIndex) {
  let depth = 1;
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = startIndex; index < command.length; index += 1) {
    const char = command[index];

    if (singleQuoted) {
      if (char === '\'') {
        singleQuoted = false;
      }
      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (!doubleQuoted && char === '\'') {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }

    if (char === '`') {
      const endIndex = findBacktickCommandEnd(command, index + 1);
      if (endIndex === -1) {
        return -1;
      }
      index = endIndex;
      continue;
    }

    const openerLength = commandSubstitutionOpenerLength(command, index);
    if (openerLength > 0) {
      depth += 1;
      index += openerLength - 1;
      continue;
    }

    if (!doubleQuoted && char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function shellCommandSubstitutions(command) {
  const substitutions = [];
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (singleQuoted) {
      if (char === '\'') {
        singleQuoted = false;
      }
      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (!doubleQuoted && char === '\'') {
      singleQuoted = true;
      continue;
    }

    if (char === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }

    if (char === '`') {
      const endIndex = findBacktickCommandEnd(command, index + 1);
      if (endIndex === -1) {
        break;
      }
      substitutions.push(command.slice(index + 1, endIndex));
      index = endIndex;
      continue;
    }

    const openerLength = commandSubstitutionOpenerLength(command, index);
    if (openerLength > 0) {
      const endIndex = findCommandSubstitutionEnd(command, index + openerLength);
      if (endIndex === -1) {
        break;
      }
      substitutions.push(command.slice(index + openerLength, endIndex));
      index = endIndex;
    }
  }

  return substitutions;
}

function hasTopLevelPipeline(command) {
  return parseShellTokens(command).some(token => token?.op === '|');
}

function shellFunctionDefinitionStart(segment) {
  const tokens = parseShellTokens(segment);
  let index = 0;

  if (tokens[index] === 'function') {
    index += 1;
  }

  const name = tokens[index];
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return undefined;
  }
  index += 1;

  if (tokens[index]?.op === '(' && tokens[index + 1]?.op === ')') {
    index += 2;
  }

  if (tokens[index] !== '{') {
    return undefined;
  }

  const initialBody = shellTokensToCommand(tokens.slice(index + 1));
  return {
    initialBody,
    name
  };
}

function closesShellFunctionDefinition(segment) {
  return segment.trim() === '}';
}

function invokedShellFunction(segment, shellFunctions) {
  const tokens = normalizedCommandTokens(segment);
  const name = tokens[0];
  if (typeof name !== 'string' || !shellFunctions.has(name)) {
    return undefined;
  }

  return {
    bodyCommands: shellFunctions.get(name) ?? [],
    name
  };
}

function commandExecutionSegments(
  command,
  inheritedState = { failOpen: false, piped: false },
  shellFunctions = new Map(),
  pendingFunction,
  activeFunctions = new Set()
) {
  const clauses = shellCommandClauses(command);
  const failOpen = inheritedState.failOpen || clauses.some(clause => clause.separatorAfter === '||');
  const segments = [];
  let openFunction = pendingFunction;

  for (const clause of clauses) {
    if (openFunction) {
      if (closesShellFunctionDefinition(clause.text)) {
        shellFunctions.set(openFunction.name, [...openFunction.bodyCommands]);
        openFunction = undefined;
        continue;
      }

      openFunction.bodyCommands.push(clause.text);
      continue;
    }

    const functionDefinition = shellFunctionDefinitionStart(clause.text);
    if (functionDefinition) {
      openFunction = {
        bodyCommands: functionDefinition.initialBody ? [functionDefinition.initialBody] : [],
        name: functionDefinition.name
      };
      continue;
    }

    const invokedFunction = invokedShellFunction(clause.text, shellFunctions);
    if (invokedFunction && !activeFunctions.has(invokedFunction.name)) {
      const nextActiveFunctions = new Set(activeFunctions);
      nextActiveFunctions.add(invokedFunction.name);

      for (const bodyCommand of invokedFunction.bodyCommands) {
        const result = commandExecutionSegments(
          bodyCommand,
          {
            failOpen,
            piped: inheritedState.piped || hasTopLevelPipeline(clause.text)
          },
          shellFunctions,
          undefined,
          nextActiveFunctions
        );
        segments.push(...result.segments);
      }
      continue;
    }

    const segmentState = {
      failOpen,
      piped: inheritedState.piped || hasTopLevelPipeline(clause.text)
    };
    const innerCommand = shellInterpreterCommand(clause.text);

    if (innerCommand && innerCommand !== clause.text) {
      const result = commandExecutionSegments(innerCommand, segmentState);
      segments.push(...result.segments);
      continue;
    }

    segments.push({
      text: clause.text,
      ...segmentState
    });
  }

  return {
    pendingFunction: openFunction,
    segments
  };
}

function stepExecutionSegments(step) {
  const shellFunctions = new Map();
  let pendingFunction;
  const segments = [];

  for (const command of commandsFromRunValue(step?.run)) {
    const result = commandExecutionSegments(command, { failOpen: false, piped: false }, shellFunctions, pendingFunction);
    pendingFunction = result.pendingFunction;
    segments.push(...result.segments);
  }

  return segments;
}

function jobExecutionSegments(job) {
  return job.steps.flatMap((step, stepIndex) =>
    stepExecutionSegments(step).map(segment => ({
      ...segment,
      stepIndex
    }))
  );
}

function segmentMatchesCommand(segment, matcher) {
  const normalized = normalizeCommandSegment(segment);
  if (matcher(normalized)) {
    return true;
  }

  const innerCommand = shellInterpreterCommand(segment);
  if (!innerCommand || innerCommand === segment) {
    return false;
  }

  return shellCommandSegments(innerCommand).some(innerSegment => segmentMatchesCommand(innerSegment, matcher));
}

function matchesNpmCiInvocation(normalized) {
  const tokens = parseShellTokens(normalized).filter(token => typeof token === 'string');
  if (tokens[0] !== 'npm') {
    return false;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'ci') {
      return true;
    }
    if (!token.startsWith('-')) {
      return false;
    }

    const nextToken = tokens[index + 1];
    if (typeof nextToken === 'string' && !nextToken.startsWith('-') && nextToken !== 'ci') {
      index += 1;
    }
  }

  return false;
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
      steps: Array.isArray(job.steps)
        ? job.steps.filter(step => step && typeof step === 'object')
        : []
    }));
}

function shellTemplateEnablesErrexit(shell) {
  if (typeof shell !== 'string' || !shell.trim()) {
    return true;
  }

  const tokens = parseShellTokens(shell).filter(token => typeof token === 'string');
  const shellToken = tokens[0];
  if (typeof shellToken !== 'string') {
    return false;
  }

  const shellName = shellToken.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || shellToken;
  if (!new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']).has(shellName)) {
    return false;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-o' || token === '+o') {
      if (tokens[index + 1] === 'errexit') {
        return token === '-o';
      }
      continue;
    }

    if (token.startsWith('-') && token.slice(1).includes('e')) {
      return true;
    }

    if (token.startsWith('+') && token.slice(1).includes('e')) {
      return false;
    }
  }

  return false;
}

function npmCiProvenanceViolations(workflow) {
  const violations = [];

  for (const job of workflowJobs(workflow)) {
    let availableChecks = 0;
    let installIndex = 0;
    let currentStepIndex = -1;
    let errexitDisabled = false;

    for (const segment of jobExecutionSegments(job)) {
      if (segment.stepIndex !== currentStepIndex) {
        currentStepIndex = segment.stepIndex;
        errexitDisabled = !shellTemplateEnablesErrexit(job.steps[currentStepIndex]?.shell);
      }

      const errexitMode = segmentErrexitMode(segment.text);

      if (!errexitDisabled && isProvenanceCheckSegment(segment)) {
        availableChecks += 1;
      }

      if (isNpmCiSegment(segment)) {
        if (availableChecks > 0) {
          availableChecks -= 1;
          installIndex += 1;
          continue;
        }

        violations.push({
          jobName: job.jobName,
          installIndex
        });
        installIndex += 1;
        continue;
      }

      if (errexitMode !== undefined) {
        errexitDisabled = !errexitMode;
      }
    }
  }

  return violations;
}

function isProvenanceCheckCommand(command) {
  return commandExecutionSegments(command).segments.some(isProvenanceCheckSegment);
}

function isProvenanceCheckSegment(segment) {
  if (segment.failOpen || segment.piped) {
    return false;
  }

  return segmentMatchesCommand(
    segment.text,
    normalized => /^node scripts\/check-dependency-sources\.mjs(?=$|[\s)])/.test(normalized)
  );
}

function isNpmCiCommand(command) {
  return commandExecutionSegments(command).segments.some(isNpmCiSegment);
}

function isNpmCiSegment(segment) {
  if (segmentMatchesCommand(segment.text, normalized => matchesNpmCiInvocation(normalized))) {
    return true;
  }

  return shellCommandSubstitutions(segment.text).some(substitution =>
    shellCommandSegments(substitution).some(innerSegment =>
      isNpmCiSegment({ text: innerSegment })
    )
  );
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

test('Claude workflow only responds to trusted collaborators and has write permissions for repo actions', () => {
  const workflow = yaml.parse(read('.github/workflows/claude.yml'));
  const job = workflow.jobs.claude;
  const actionStep = job.steps.find(step => step.id === 'claude');

  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment'
  ]);
  assert.equal(job.permissions.contents, 'write');
  assert.equal(job.permissions['pull-requests'], 'write');
  assert.equal(job.permissions.issues, 'write');
  assert.equal(job.permissions.actions, 'read');
  assert.match(job.if, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(job.if, /github\.event\.comment\.author_association == 'MEMBER'/);
  assert.match(job.if, /github\.event\.comment\.author_association == 'COLLABORATOR'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'OWNER'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'MEMBER'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'COLLABORATOR'/);
  assert.equal(actionStep.with.claude_args, undefined);
});

test('Claude review workflow skips the action when the OAuth token is unavailable', () => {
  const workflow = yaml.parse(read('.github/workflows/claude-code-review.yml'));
  const job = workflow.jobs['claude-review'];
  const bunSetupStep = job.steps.find(
    step => step.name === 'Install Bun for Claude review wrapper'
  );
  const bunWrapperStep = job.steps.find(
    step => step.name === 'Prepare Claude review Bun wrapper'
  );
  const actionStep = job.steps.find(step => step.id === 'claude-review');
  const limitStep = job.steps.find(
    step => step.name === 'Allow Claude usage-limit exhaustion'
  );
  const skipStep = job.steps.find(
    step => step.name === 'Skip Claude Code Review when OAuth token is unavailable'
  );

  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['pull-requests'], 'write');
  assert.equal(job.permissions.actions, 'read');
  assert.equal(job.permissions.checks, undefined);
  assert.equal(job.permissions.issues, undefined);
  assert.equal(job.env.CLAUDE_CODE_OAUTH_TOKEN, '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
  assert.equal(bunSetupStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.equal(bunWrapperStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.match(bunWrapperStep.run, /REAL_BUN_PATH=/);
  assert.match(bunWrapperStep.run, /CLAUDE_REVIEW_BUN_PATH=/);
  assert.match(bunWrapperStep.run, /CLAUDE_BUN_LOG_PATH=/);
  assert.match(bunWrapperStep.run, /tee -a "\$\{CLAUDE_BUN_LOG_PATH:\?\}"/);
  assert.equal(actionStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.equal(actionStep.env.REAL_BUN_PATH, '${{ env.REAL_BUN_PATH }}');
  assert.equal(actionStep.env.CLAUDE_BUN_LOG_PATH, '${{ env.CLAUDE_BUN_LOG_PATH }}');
  assert.equal(actionStep.with.claude_code_oauth_token, '${{ env.CLAUDE_CODE_OAUTH_TOKEN }}');
  assert.equal(actionStep.with.github_token, '${{ github.token }}');
  assert.equal(actionStep.with.path_to_bun_executable, '${{ env.CLAUDE_REVIEW_BUN_PATH }}');
  assert.equal(actionStep['continue-on-error'], true);
  assert.equal(actionStep.with.claude_args, undefined);
  assert.equal(limitStep.if, "${{ steps.claude-review.outcome == 'failure' }}");
  assert.equal(limitStep.env.CLAUDE_BUN_LOG_PATH, '${{ env.CLAUDE_BUN_LOG_PATH }}');
  assert.match(limitStep.run, /claude-execution-output\.json/);
  assert.match(limitStep.run, /claude-review-bun\.log/);
  assert.match(limitStep.run, /CLAUDE_BUN_LOG_PATH/);
  assert.match(limitStep.run, /Action failed with error:/);
  assert.match(limitStep.run, /You've hit your limit/);
  assert.match(limitStep.run, /subtype !== 'success'/);
  assert.equal(skipStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN == '' }}");
  assert.match(skipStep.run, /Skipping Claude Code Review because CLAUDE_CODE_OAUTH_TOKEN is unavailable/);
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

test('provenance detection handles shell interpreter wrappers', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: bash -c \"node scripts/check-dependency-sources.mjs\"',
    '      - run: npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(workflow, isProvenanceCheckCommand);
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 1);
  assert.equal(npmInstalls.length, 1);
  assert.ok(provenanceChecks[0] < npmInstalls[0]);
});

test('fail-open provenance commands do not count as validation', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: node scripts/check-dependency-sources.mjs || true',
    '      - run: npm ci'
  ].join('\n');

  const provenanceChecks = commandIndexes(workflow, isProvenanceCheckCommand);
  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);

  assert.equal(provenanceChecks.length, 0);
  assert.equal(npmInstalls.length, 1);
});

test('provenance commands in top-level OR fallback chains do not count as validation', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: node scripts/check-dependency-sources.mjs && echo ok || true',
    '      - run: npm ci'
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

test('quoted dash heredoc terminators do not hide later npm ci commands', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    "          cat <<'-EOF'",
    '          node scripts/check-dependency-sources.mjs',
    '          -EOF',
    '          npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    }
  ]);
});

test('echoed heredoc opener text does not hide later npm ci commands', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    "          echo \"<<'-EOF'\"",
    '          npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    }
  ]);
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

test('npm ci provenance detection handles command substitutions', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: echo $(npm ci)',
    '      - run: echo `npm ci`'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    },
    {
      jobName: 'test',
      installIndex: 1
    }
  ]);
});

test('set +e disables provenance protection until errexit is restored', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: set +e; node scripts/check-dependency-sources.mjs; npm ci',
    '      - run: set +e; node scripts/check-dependency-sources.mjs; set -e; npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    },
    {
      jobName: 'test',
      installIndex: 1
    }
  ]);
});

test('npm ci provenance detection handles utility-prefixed installs', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: nohup npm ci',
    '      - run: nice -n 5 npm ci',
    '      - run: ionice -c3 npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    },
    {
      jobName: 'test',
      installIndex: 1
    },
    {
      jobName: 'test',
      installIndex: 2
    }
  ]);
});

test('npm ci provenance detection handles wrapper options with separate values', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: sudo -u root npm ci',
    '      - run: env -u PATH npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    },
    {
      jobName: 'test',
      installIndex: 1
    }
  ]);
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

test('npm ci provenance detection handles inline shell conditionals', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: if true; then npm ci && npm test; fi'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles shell interpreter wrappers', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: bash -c \"npm ci\"'
  ].join('\n');

  const npmInstalls = commandIndexes(workflow, isNpmCiCommand);
  assert.equal(npmInstalls.length, 1);
});

test('npm ci provenance detection handles shell function invocations', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: |',
    '          f() {',
    '            npm ci',
    '          }',
    '      - run: inline(){ npm ci; }; inline',
    '      - run: |',
    '          g() {',
    '            npm ci',
    '          }',
    '          g',
    '      - run: check_inline(){ node scripts/check-dependency-sources.mjs; npm ci; }; check_inline',
    '      - run: |',
    '          h() {',
    '            node scripts/check-dependency-sources.mjs',
    '            npm ci',
    '          }',
    '          h'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    },
    {
      jobName: 'test',
      installIndex: 1
    }
  ]);
});

test('npm ci provenance detection handles npm flags before the subcommand', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - run: npm --prefix . ci'
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

test('step shell metadata controls initial errexit protection', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - shell: bash {0}',
    '        run: |',
    '          node scripts/check-dependency-sources.mjs',
    '          npm ci',
    '      - shell: bash -e {0}',
    '        run: |',
    '          node scripts/check-dependency-sources.mjs',
    '          npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), [
    {
      jobName: 'test',
      installIndex: 0
    }
  ]);
});

test('dependency provenance validation accepts same-line checks before npm ci', () => {
  const workflow = [
    'jobs:',
    '  install:',
    '    steps:',
    '      - run: node scripts/check-dependency-sources.mjs && npm ci'
  ].join('\n');

  assert.deepEqual(npmCiProvenanceViolations(workflow), []);
});

test('piped provenance checks do not satisfy npm ci validation', () => {
  const workflow = [
    'jobs:',
    '  install:',
    '    steps:',
    '      - run: node scripts/check-dependency-sources.mjs | cat',
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
