import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { installSkill } from '../src/skillInstaller.ts';
import { selectSkillAgents } from '../src/skillPrompt.ts';
import { agentIds, detectSkillAgents, resolveSkillTargets, skillName } from '../src/skillTargets.ts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-skill test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'plugin');
  const source = path.join(packageRoot, 'skills', skillName);
  await fs.mkdir(path.join(source, 'agents'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), `---\nname: ${skillName}\n---\nPortable skill\n`);
  await fs.writeFile(path.join(source, 'agents/openai.yaml'), 'interface: {}\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), '{"version":"0.3.0"}');
  const environment = { cwd: path.join(root, 'workspace'), home: path.join(root, 'home'), env: {} };
  await fs.mkdir(environment.cwd);
  return { root, source, packageRoot, environment };
}

test('project installation copies every file and deduplicates Codex/Copilot', async t => {
  const fixtureData = await fixture(t);
  const result = await installSkill({ agents: [...agentIds] }, fixtureData);
  assert.equal(result.pluginVersion, '0.3.0');
  assert.equal(result.installations.length, 3);
  assert.deepEqual(result.installations[1]?.agents, ['codex', 'github-copilot']);
  for (const installation of result.installations) {
    assert.equal(installation.status, 'installed');
    assert.equal(installation.scope, 'project');
    assert.equal((await fs.lstat(installation.destination)).isSymbolicLink(), false);
    for (const file of result.files) {
      assert.deepEqual(
        await fs.readFile(path.join(installation.destination, file)),
        await fs.readFile(path.join(result.source, file))
      );
    }
  }
  const again = await installSkill({ agents: [...agentIds] }, fixtureData);
  assert.ok(again.installations.every(item => item.status === 'unchanged'));
});

test('global presets respect the supported configuration variables', async t => {
  const data = await fixture(t);
  data.environment.env = {
    CODEX_HOME: path.join(data.root, 'custom codex'),
    CLAUDE_CONFIG_DIR: path.join(data.root, 'custom claude'),
    XDG_CONFIG_HOME: path.join(data.root, 'custom config')
  };
  const result = await installSkill({ agents: [...agentIds], global: true }, data);
  assert.deepEqual(
    result.installations.map(item => item.destination),
    [
      path.join(data.root, 'custom claude/skills', skillName),
      path.join(data.root, 'custom codex/skills', skillName),
      path.join(data.environment.home, '.copilot/skills', skillName),
      path.join(data.root, 'custom config/devin/skills', skillName)
    ]
  );
});

test('global defaults, explicit project, custom directory and legacy Codex home resolve predictably', async t => {
  const data = await fixture(t);
  const defaults = resolveSkillTargets({ agents: [...agentIds], global: true }, data.environment);
  assert.deepEqual(
    defaults.map(item => path.relative(data.environment.home, item.destination).split(path.sep).join('/')),
    [
      `.claude/skills/${skillName}`,
      `.codex/skills/${skillName}`,
      `.copilot/skills/${skillName}`,
      `.config/devin/skills/${skillName}`
    ]
  );
  for (const [options, suffix] of [
    [{ agents: ['codex'], workspaceRoot: 'other project' }, `other project/.agents/skills/${skillName}`],
    [{ skillsDir: 'custom skills' }, `custom skills/${skillName}`],
    [{ codexHome: 'legacy codex' }, `legacy codex/skills/${skillName}`]
  ] as const) {
    const result = await installSkill(
      { ...options, ...('agents' in options ? { agents: [...options.agents] } : {}) },
      data
    );
    assert.equal(result.installations[0]?.destination, path.join(data.environment.cwd, suffix));
  }
});

test('dry-run writes nothing and replacement requires force even during preview', async t => {
  const data = await fixture(t);
  const options = { agents: ['codex'] };
  const preview = await installSkill({ ...options, dryRun: true }, data);
  assert.equal(preview.installations[0]?.status, 'wouldInstall');
  assert.deepEqual(await fs.readdir(data.environment.cwd), []);
  const result = await installSkill(options, data);
  const destination = result.installations[0]!.destination;
  await fs.writeFile(path.join(destination, 'custom.md'), 'keep until explicitly replaced');
  await assert.rejects(installSkill(options, data), /--force/);
  await assert.rejects(installSkill({ ...options, dryRun: true }, data), /--force/);
  const replacement = await installSkill({ ...options, force: true, dryRun: true }, data);
  assert.equal(replacement.installations[0]?.status, 'wouldReplace');
  await fs.access(path.join(destination, 'custom.md'));
  await fs.mkdir(path.join(path.dirname(destination), 'another-skill'));
  const replaced = await installSkill({ ...options, force: true }, data);
  assert.equal(replaced.installations[0]?.status, 'replaced');
  await assert.rejects(fs.access(path.join(destination, 'custom.md')));
  await fs.access(path.join(path.dirname(destination), 'another-skill'));
});

test('all targets are preflighted before the first write', async t => {
  const data = await fixture(t);
  const [existing] = resolveSkillTargets({ agents: ['codex'] }, data.environment);
  await fs.mkdir(existing!.destination, { recursive: true });
  await fs.writeFile(path.join(existing!.destination, 'custom.md'), 'custom');
  await assert.rejects(installSkill({ agents: ['claude-code', 'codex'] }, data), /--force/);
  await assert.rejects(fs.access(path.join(data.environment.cwd, '.claude')));
});

test('missing or invalid bundle does not fall back to the working directory', async t => {
  const data = await fixture(t);
  await fs.cp(path.join(data.packageRoot, 'skills'), path.join(data.environment.cwd, 'skills'), { recursive: true });
  await fs.rm(path.join(data.source, 'SKILL.md'));
  await assert.rejects(installSkill({ agents: ['codex'] }, data), /missing or invalid/);
  await fs.rm(data.source, { recursive: true });
  await assert.rejects(installSkill({ agents: ['codex'] }, data), /Bundled skill is missing/);
});

test('permission failures propagate without being mistaken for missing destinations', async t => {
  const data = await fixture(t);
  await assert.rejects(
    installSkill(
      { agents: ['codex'] },
      {
        ...data,
        io: {
          ...fs,
          lstat: async () => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          }
        }
      }
    ),
    /permission denied/
  );
  assert.deepEqual(await fs.readdir(data.environment.cwd), []);
});

test('failed promotion restores the existing directory and removes temporary files', async t => {
  const data = await fixture(t);
  const options = { agents: ['codex'] };
  const result = await installSkill(options, data);
  const destination = result.installations[0]!.destination;
  await fs.writeFile(path.join(destination, 'original.md'), 'original content');
  await assert.rejects(
    installSkill(
      { ...options, force: true },
      {
        ...data,
        io: {
          ...fs,
          rename: async (from, to) => {
            if (path.basename(String(from)) === 'new') throw new Error('promotion failed');
            return fs.rename(from, to);
          }
        }
      }
    ),
    /promotion failed/
  );
  assert.equal(await fs.readFile(path.join(destination, 'original.md'), 'utf8'), 'original content');
  assert.deepEqual(await fs.readdir(path.dirname(destination)), [skillName]);
});

test('failed rollback retains a recoverable backup and reports its path', async t => {
  const data = await fixture(t);
  const options = { agents: ['codex'] };
  const result = await installSkill(options, data);
  const destination = result.installations[0]!.destination;
  await fs.writeFile(path.join(destination, 'original.md'), 'original content');
  await assert.rejects(
    installSkill(
      { ...options, force: true },
      {
        ...data,
        io: {
          ...fs,
          rename: async (from, to) => {
            if (['new', 'previous'].includes(path.basename(String(from)))) throw new Error('rename failed');
            return fs.rename(from, to);
          }
        }
      }
    ),
    /previous skill is preserved at/
  );
  const [temporary] = await fs.readdir(path.dirname(destination));
  assert.equal(
    await fs.readFile(path.join(path.dirname(destination), temporary!, 'previous/original.md'), 'utf8'),
    'original content'
  );
});

test('symlink or junction destinations are refused even with force', async t => {
  const data = await fixture(t);
  const [target] = resolveSkillTargets({ agents: ['codex'] }, data.environment);
  await fs.mkdir(path.dirname(target!.destination), { recursive: true });
  await fs.symlink(data.source, target!.destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installSkill({ agents: ['codex'], force: true }, data), /symlink\/junction/);
  await fs.access(path.join(data.source, 'SKILL.md'));
});

test('bundle overlap, empty destinations and conflicting selectors are rejected', async t => {
  const data = await fixture(t);
  await assert.rejects(installSkill({ skillsDir: path.dirname(data.source) }, data), /overlap/);
  for (const options of [
    {},
    { agents: ['unknown'] },
    { skillsDir: '' },
    { skillsDir: 'a', agents: ['codex'] },
    { codexHome: 'a', global: true },
    { global: true, workspaceRoot: 'a', agents: ['codex'] },
    { codexHome: 'a', skillsDir: 'b' }
  ])
    assert.throws(() => resolveSkillTargets(options, data.environment));
});

test('detection is local and the menu requires a selection, including when none are detected', async t => {
  const data = await fixture(t);
  assert.deepEqual(await detectSkillAgents(data.environment), []);
  await fs.mkdir(path.join(data.environment.home, '.codex'), { recursive: true });
  await fs.mkdir(path.join(data.environment.cwd, '.claude'), { recursive: true });
  assert.deepEqual(await detectSkillAgents(data.environment), ['claude-code', 'codex']);
  let questions = 0;
  const selected = await selectSkillAgents(['codex'], async message => {
    assert.match(message, /1\. codex \(detected\)/);
    return questions++ === 0 ? 'invalid' : '1,2,1';
  });
  assert.deepEqual(selected, ['codex', 'claude-code']);
  assert.equal(questions, 2);
  assert.deepEqual(await selectSkillAgents([], async () => '4'), ['devin']);
  await assert.rejects(
    selectSkillAgents([], async () => ''),
    /cancelled/
  );
});
