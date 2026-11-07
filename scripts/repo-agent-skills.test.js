const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');
const repoRoot = path.resolve(__dirname, '..');

// Repo-only agent skills live in .agents/skills/<name>/, which Hermes, Codex and other agents read.
// Claude Code reads only .claude/skills/, so each skill has a relative symlink there. The git index
// is read rather than the disk, because a Windows checkout without symlink support writes a symlink
// as a plain file.

const git = args => {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const indexEntries = dir =>
  git(['ls-files', '-s', '--', dir])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [meta, file] = line.split('\t');
      const [mode, blob] = meta.split(' ');
      return { mode, blob, file };
    });

const skillNames = () => [...new Set(indexEntries('.agents/skills').map(entry => entry.file.split('/')[2]))].sort();

test('every repo skill is a directory in .agents/skills with one link from .claude/skills', () => {
  const names = skillNames();
  assert.ok(names.includes('verify-apex-log-viewer'), `expected the verify skill among ${names}`);
  const files = new Set(indexEntries('.agents/skills').map(entry => entry.file));
  for (const name of names) {
    assert.ok(
      files.has(`.agents/skills/${name}/SKILL.md`),
      `.agents/skills/${name} must be a directory with a SKILL.md`
    );
  }
  const links = indexEntries('.claude/skills');
  for (const link of links) {
    assert.equal(link.mode, '120000', `${link.file} must be a symlink to .agents/skills, not a copy`);
  }
  assert.deepEqual(
    links.map(link => git(['cat-file', '-p', link.blob])).sort(),
    names.map(name => `../../.agents/skills/${name}`),
    'each .agents/skills/<name> needs `ln -s ../../.agents/skills/<name> .claude/skills/<name>`'
  );
});

test('every repo skill names itself and stays out of the public skills catalog', () => {
  for (const name of skillNames()) {
    const text = fs.readFileSync(path.join(repoRoot, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(frontmatter, `${name}/SKILL.md needs YAML frontmatter, or no agent registers it`);
    assert.match(frontmatter, new RegExp(`^name: ${name}$`, 'm'), `${name}/SKILL.md name`);
    assert.match(frontmatter, /^description: \S/m, `${name}/SKILL.md description`);
    // `npx skills add electivus/apex-log-viewer` publishes every skill it finds unless it is internal.
    assert.match(frontmatter, /^metadata:\n(?:\s+#.*\n)*\s+internal: true$/m, `${name}/SKILL.md metadata.internal`);
  }
});

test('every path filter of the capture lease workflow matches a tracked file', () => {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'capture-lease-check.yml'), 'utf8')
  );
  for (const entry of workflow.on.pull_request.paths) {
    const target = entry.replace(/\/\*\*$/, '');
    assert.ok(
      indexEntries(target).length > 0,
      `capture-lease-check.yml paths entry ${entry} matches no tracked file, so the check would never run`
    );
  }
});
