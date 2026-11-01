const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const repoRoot = path.resolve(__dirname, '..');

// Repo-only agent skills live in .claude/skills/<name>/, the one place Claude Code reads. Hermes,
// Codex and other agents read .agents/skills/, so each skill has a relative symlink there. The git
// index is read rather than the disk, because a Windows checkout without symlink support writes a
// symlink as a plain file.

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

const skillNames = () =>
  [...new Set(indexEntries('.claude/skills').map(entry => entry.file.split('/')[2]))]
    .filter(name => indexEntries(`.claude/skills/${name}/SKILL.md`).length === 1)
    .sort();

test('every repo skill is in .claude/skills and linked from .agents/skills, and nothing else is there', () => {
  const names = skillNames();
  assert.ok(names.includes('verify'), `expected the verify skill among ${names}`);
  const links = indexEntries('.agents/skills');
  for (const link of links) {
    assert.equal(link.mode, '120000', `${link.file} must be a symlink to .claude/skills, not a copy`);
  }
  assert.deepEqual(
    links.map(link => link.file),
    names.map(name => `.agents/skills/${name}`),
    'each .claude/skills/<name> needs `ln -s ../../.claude/skills/<name> .agents/skills/<name>`'
  );
  for (const link of links) {
    const name = path.posix.basename(link.file);
    assert.equal(git(['cat-file', '-p', link.blob]), `../../.claude/skills/${name}`, `${link.file} target`);
  }
});

test('every repo skill names itself and stays out of the public skills catalog', () => {
  for (const name of skillNames()) {
    const text = fs.readFileSync(path.join(repoRoot, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(frontmatter, `${name}/SKILL.md needs YAML frontmatter, or no agent registers it`);
    assert.match(frontmatter, new RegExp(`^name: ${name}$`, 'm'), `${name}/SKILL.md name`);
    assert.match(frontmatter, /^description: \S/m, `${name}/SKILL.md description`);
    // `npx skills add electivus/apex-log-viewer` publishes every skill it finds unless it is internal.
    assert.match(frontmatter, /^metadata:\n(?:\s+#.*\n)*\s+internal: true$/m, `${name}/SKILL.md metadata.internal`);
  }
});
