import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { installSkill, installSkills } from '../src/skillInstaller.ts';
import { selectSkillAgents } from '../src/skillPrompt.ts';
import { agentIds, detectSkillAgents, resolveSkillTargets, skillName, skillNames } from '../src/skillTargets.ts';

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

async function catalogFixture(t: TestContext) {
  const data = await fixture(t);
  for (const name of skillNames.slice(1)) {
    const source = path.join(data.packageRoot, 'skills', name);
    await fs.mkdir(path.join(source, 'references'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), `---\nname: ${name}\n---\nInvestigation\n`);
    await fs.writeFile(path.join(source, 'references', 'scenario.md'), 'Standalone reference\n');
  }
  return data;
}

test('explicit catalog selection installs all skills and deduplicates shared agent destinations', async t => {
  const data = await catalogFixture(t);
  const options = { agents: ['codex', 'github-copilot', 'claude-code'], all: true };
  const result = await installSkills(options, data);
  assert.ok('skills' in result);
  assert.deepEqual(
    result.skills.map(item => item.skillName),
    [...skillNames]
  );
  for (const item of result.skills) {
    assert.equal(item.installations.length, 2);
    for (const installation of item.installations) {
      assert.equal(installation.status, 'installed');
      for (const file of item.files) {
        assert.deepEqual(
          await fs.readFile(path.join(installation.destination, file)),
          await fs.readFile(path.join(item.source, file))
        );
      }
    }
  }
  const again = await installSkills(options, data);
  assert.ok('skills' in again);
  assert.ok(again.skills.every(item => item.installations.every(target => target.status === 'unchanged')));
  const legacy = await installSkills({ agents: ['codex'] }, data);
  assert.ok(!('skills' in legacy));
  assert.equal(legacy.skillName, skillName);
});

test('selected skills use the collection envelope even for one name and preserve legacy default', async t => {
  const data = await catalogFixture(t);
  const name = 'apex-debug-investigate';
  const result = await installSkills({ skills: [name, name], skillsDir: 'custom skills' }, data);
  assert.ok('skills' in result);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]!.installations[0]!.destination, path.join(data.environment.cwd, 'custom skills', name));
  await assert.rejects(fs.access(path.join(data.environment.cwd, 'custom skills', skillName)));
  for (const options of [{ all: true, skills: [name] }, { skills: [] }, { skills: ['../outside'] }]) {
    await assert.rejects(
      installSkills({ ...options, agents: ['codex'] }, data),
      /mutually exclusive|at least one|Unsupported skill/
    );
  }
});

test('all skills are preflighted before writes, including replacement conflicts in the last skill', async t => {
  const data = await catalogFixture(t);
  const name = 'apex-debug-performance';
  const existing = path.join(data.environment.cwd, '.agents/skills', name);
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, 'custom.md'), 'preserve');
  await assert.rejects(installSkills({ all: true, agents: ['codex', 'claude-code'] }, data), /--force/);
  await assert.rejects(fs.access(path.join(data.environment.cwd, '.claude')));
  await assert.rejects(fs.access(path.join(data.environment.cwd, '.agents/skills', skillName)));
  const preview = await installSkills({ all: true, agents: ['codex'], dryRun: true, force: true }, data);
  assert.ok('skills' in preview);
  assert.equal(preview.skills.at(-1)!.installations[0]!.status, 'wouldReplace');
  assert.equal(await fs.readFile(path.join(existing, 'custom.md'), 'utf8'), 'preserve');
});

test('a selected skill cannot overwrite a different source skill in its own bundle', async t => {
  const data = await catalogFixture(t);
  await assert.rejects(
    installSkills({ skills: ['apex-debug-performance'], skillsDir: path.dirname(data.source), force: true }, data),
    /overlap/
  );
});

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

test('cleanup failure reports a committed replacement with a warning and continues other destinations', async t => {
  const data = await fixture(t);
  const installed = await installSkill({ agents: ['codex'] }, data);
  const destination = installed.installations[0]!.destination;
  await fs.writeFile(path.join(destination, 'old.md'), 'previous content');
  const result = await installSkill(
    { agents: ['codex', 'claude-code'], force: true },
    {
      ...data,
      io: {
        ...fs,
        rm: async (target, options) => {
          if (String(target).startsWith(path.join(path.dirname(destination), '.alv-skill-'))) {
            throw Object.assign(new Error('backup temporarily locked'), { code: 'EBUSY' });
          }
          return fs.rm(target, options);
        }
      }
    }
  );
  assert.deepEqual(
    result.installations.map(item => item.status),
    ['replaced', 'installed']
  );
  assert.match(
    result.installations[0]!.warnings![0]!,
    /Could not clean temporary skill directory .*backup temporarily locked/
  );
  assert.equal(result.installations[1]?.warnings, undefined);
  await assert.rejects(fs.access(path.join(destination, 'old.md')));
  for (const item of result.installations) await fs.access(path.join(item.destination, 'SKILL.md'));
  const backupDirectory = (await fs.readdir(path.dirname(destination))).find(name => name.startsWith('.alv-skill-'))!;
  assert.equal(
    await fs.readFile(path.join(path.dirname(destination), backupDirectory, 'previous/old.md'), 'utf8'),
    'previous content'
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

test('ancestor symlinks cannot redirect a project installation or force replacement outside the workspace', async t => {
  const data = await fixture(t);
  const external = path.join(data.root, 'external');
  const existing = path.join(external, 'skills', skillName);
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, 'SKILL.md'), 'external user content');
  await fs.symlink(
    external,
    path.join(data.environment.cwd, '.agents'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  for (const dryRun of [false, true]) {
    await assert.rejects(installSkill({ agents: ['codex'], force: true, dryRun }, data), /symlink\/junction/);
  }
  assert.equal(await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8'), 'external user content');
  assert.deepEqual(await fs.readdir(path.join(external, 'skills')), [skillName]);
});

test('an explicitly selected workspace can use an OS path alias without allowing redirects below it', async t => {
  const data = await fixture(t);
  const alias = path.join(data.root, 'workspace alias');
  await fs.symlink(data.environment.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await installSkill({ agents: ['codex'], workspaceRoot: alias }, data);
  assert.equal(result.installations[0]?.status, 'installed');
  await fs.access(path.join(data.environment.cwd, '.agents/skills', skillName, 'SKILL.md'));
});

test('Devin rejects a redirected directory below an external XDG_CONFIG_HOME', async t => {
  const data = await fixture(t);
  const config = path.join(data.root, 'external config');
  const unrelated = path.join(data.root, 'unrelated');
  await fs.mkdir(config);
  await fs.mkdir(path.join(unrelated, 'skills'), { recursive: true });
  await fs.symlink(unrelated, path.join(config, 'devin'), process.platform === 'win32' ? 'junction' : 'dir');
  data.environment.env = { XDG_CONFIG_HOME: config };
  await assert.rejects(installSkill({ agents: ['devin'], global: true, force: true }, data), /symlink\/junction/);
  assert.deepEqual(await fs.readdir(path.join(unrelated, 'skills')), []);
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
