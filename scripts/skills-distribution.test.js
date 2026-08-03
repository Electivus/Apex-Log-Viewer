const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const skillsCli = path.join(repoRoot, 'node_modules', 'skills', 'bin', 'cli.mjs');

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function formatCommandOutput(result, { stripColors = false } = {}) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  return stripColors ? stripAnsi(output) : output;
}

function runSkills(args, cwd = repoRoot, env = {}) {
  return spawnSync(process.execPath, [skillsCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      NO_COLOR: '1',
      ...env
    },
    timeout: 120_000
  });
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  const output = formatCommandOutput(result);
  assert.equal(result.status, 0, output);
}

test('the neutral catalog discovers exactly the portable Apex Log Viewer Agent Skill', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies?.skills, '1.5.21');

  await fs.access(path.join(repoRoot, 'skills', 'apex-log-viewer-cli', 'SKILL.md'));
  await assert.rejects(fs.access(path.join(repoRoot, '.codex', 'skills', 'apex-log-viewer-cli', 'SKILL.md')));

  const result = runSkills(['add', repoRoot, '--list']);
  const output = formatCommandOutput(result, { stripColors: true });

  assert.equal(result.status, 0, output);
  assert.match(output, /Found 1 skill\b/);
  assert.match(output, /\bapex-log-viewer-cli\b/);
  assert.doesNotMatch(output, /Trigger when Codex\b/);
});

test(
  'the pinned skills CLI installs readable deterministic content for representative agents',
  { timeout: 180_000 },
  async context => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-skills-distribution-'));
    context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

    const sourceWorktree = path.join(tempRoot, 'source-worktree');
    const bareRemote = path.join(tempRoot, 'source.git');
    await fs.mkdir(sourceWorktree, { recursive: true });
    await fs.cp(path.join(repoRoot, 'skills'), path.join(sourceWorktree, 'skills'), { recursive: true });
    await fs.writeFile(path.join(sourceWorktree, 'README.md'), '# Agent Skills test source\n', 'utf8');

    runCommand('git', ['init', '--quiet'], sourceWorktree);
    runCommand('git', ['add', '.'], sourceWorktree);
    runCommand(
      'git',
      [
        '-c',
        'user.name=Apex Log Viewer Tests',
        '-c',
        'user.email=tests@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'test source'
      ],
      sourceWorktree
    );
    runCommand('git', ['clone', '--quiet', '--bare', sourceWorktree, bareRemote], tempRoot);

    const sourceUrl = pathToFileURL(bareRemote).href;
    const targets = [
      ['claude-code', path.join('.claude', 'skills')],
      ['codex', path.join('.agents', 'skills')],
      ['github-copilot', path.join('.agents', 'skills')],
      ['devin', path.join('.devin', 'skills')]
    ];
    let expectedHash;

    for (const [agent, skillsDirectory] of targets) {
      const projectRoot = path.join(tempRoot, `project-${agent}`);
      const isolatedHome = path.join(tempRoot, `home-${agent}`);
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.mkdir(isolatedHome, { recursive: true });
      await fs.writeFile(path.join(projectRoot, 'package.json'), '{"private":true}\n', 'utf8');

      const result = runSkills(
        ['add', sourceUrl, '--skill', 'apex-log-viewer-cli', '--agent', agent, '--yes'],
        projectRoot,
        {
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, '.config')
        }
      );
      const output = formatCommandOutput(result, { stripColors: true });
      assert.equal(result.status, 0, `${agent}: ${output}`);

      const installedRoot = path.join(projectRoot, skillsDirectory, 'apex-log-viewer-cli');
      const installedSkill = await fs.readFile(path.join(installedRoot, 'SKILL.md'), 'utf8');
      await fs.access(path.join(installedRoot, 'agents', 'openai.yaml'));
      assert.match(installedSkill, /^---\r?\nname: apex-log-viewer-cli\r?\n/);
      assert.doesNotMatch(installedSkill, /Trigger when Codex\b|command -v sf|sf electivus skill install/);

      const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'skills-lock.json'), 'utf8'));
      assert.deepEqual(Object.keys(lock.skills), ['apex-log-viewer-cli']);
      const lockEntry = lock.skills['apex-log-viewer-cli'];
      assert.equal(lockEntry.source, sourceUrl);
      assert.equal(lockEntry.sourceType, 'git');
      assert.equal(lockEntry.sourceUrl, sourceUrl);
      assert.equal(lockEntry.skillPath, 'skills/apex-log-viewer-cli/SKILL.md');
      assert.match(lockEntry.computedHash, /^[a-f0-9]{64}$/);
      expectedHash ??= lockEntry.computedHash;
      assert.equal(lockEntry.computedHash, expectedHash);
    }
  }
);

test('active documentation describes the standard portable install and verify-first migration', async () => {
  const read = relativePath => fs.readFile(path.join(repoRoot, relativePath), 'utf8');
  const [readme, guide, architecture, agents, skill] = await Promise.all([
    read('README.md'),
    read(path.join('docs', 'AGENT-SKILL.md')),
    read(path.join('docs', 'ARCHITECTURE.md')),
    read('AGENTS.md'),
    read(path.join('skills', 'apex-log-viewer-cli', 'SKILL.md'))
  ]);

  assert.match(
    readme,
    /\[!\[skills\.sh\]\(https:\/\/skills\.sh\/b\/Electivus\/Apex-Log-Viewer\)\]\(https:\/\/skills\.sh\/Electivus\/Apex-Log-Viewer\)/
  );
  for (const expected of [
    'npx skills add Electivus/Apex-Log-Viewer --skill apex-log-viewer-cli',
    'npx skills add Electivus/Apex-Log-Viewer --list',
    'skills-lock.json'
  ]) {
    assert.match(`${readme}\n${guide}`, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(guide, /--global\b/);
  assert.match(guide, /verify[^\n]*before[^\n]*(remove|delet)/i);
  assert.match(guide, /Claude Code[^\n]*Codex[^\n]*GitHub Copilot[^\n]*Devin/i);
  assert.match(skill, /sf plugins install @electivus\/plugin-electivus@latest --force/);
  assert.doesNotMatch(skill, /sf plugins update @electivus\/plugin-electivus/);

  const activeGuidance = [readme, guide, architecture, agents, skill].join('\n');
  assert.doesNotMatch(activeGuidance, /sf electivus skill install/);
  assert.doesNotMatch(activeGuidance, /Codex skill/i);
});
