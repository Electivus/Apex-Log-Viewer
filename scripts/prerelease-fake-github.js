// Stands in for `gh` and `git` when scripts/packaging-ci.test.js runs steps of
// .github/workflows/prerelease.yml. The GitHub side lives in the JSON file named
// by FAKE_GITHUB_STATE: { repo, tag, tagSha, releases: [{ id, draft, target, assets }],
// apiError, listError, tagDeleteRefused }. It follows what the real API does: a draft has
// no tag, GET releases/tags/{tag} skips drafts, and publishing creates the tag.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const statePath = process.env.FAKE_GITHUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = message => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const [tool, ...args] = process.argv.slice(2);

function optionValue(names) {
  const index = args.findIndex(arg => names.includes(arg));
  return index === -1 ? undefined : args[index + 1];
}

function print(body, jq) {
  if (args.includes('--silent')) return;
  if (jq === undefined) {
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }
  const result = spawnSync('jq', ['-r', jq], { input: JSON.stringify(body), encoding: 'utf8' });
  if (result.status !== 0) fail(`jq failed: ${result.stderr}`);
  process.stdout.write(result.stdout);
}

function releaseJson(release) {
  return {
    id: release.id,
    tag_name: state.tag,
    draft: release.draft,
    prerelease: true,
    target_commitish: release.target,
    assets: release.assets.map(name => ({ name }))
  };
}

function publish(release) {
  release.draft = false;
  state.tagSha = state.tagSha || release.target;
}

function findRelease() {
  return state.releases.find(release => !release.draft) || state.releases.find(release => release.draft);
}

function runApi() {
  const valueOptions = ['-X', '--method', '--jq', '-q', '-f', '-F', '--field', '--raw-field'];
  const apiPath = args.find((arg, index) => !arg.startsWith('-') && !valueOptions.includes(args[index - 1]));
  const method = optionValue(['-X', '--method']) || 'GET';
  const jq = optionValue(['--jq', '-q']);
  const repoPath = `repos/${state.repo}`;
  if (state.apiError) fail(`gh: ${state.apiError}`);

  if (method === 'GET' && apiPath === `${repoPath}/releases`) {
    if (state.listError) fail(`gh: ${state.listError}`);
    return print(state.releases.map(releaseJson), jq);
  }
  if (method === 'GET' && apiPath === `${repoPath}/releases/tags/${state.tag}`) {
    const published = state.releases.find(release => !release.draft);
    if (!published) fail('gh: Not Found (HTTP 404)');
    return print(releaseJson(published), jq);
  }
  if (method === 'GET' && apiPath === `${repoPath}/git/matching-refs/tags/${state.tag}`) {
    const refs = state.tagSha ? [{ ref: `refs/tags/${state.tag}`, object: { sha: state.tagSha } }] : [];
    return print(refs, jq);
  }
  if (method === 'GET' && apiPath === `${repoPath}/commits/refs/tags/${state.tag}`) {
    if (!state.tagSha) fail(`gh: No commit found for SHA: ${state.tag} (HTTP 422)`);
    return print({ sha: state.tagSha }, jq);
  }
  const releaseMatch = method === 'DELETE' && new RegExp(`^${repoPath}/releases/(\\d+)$`).exec(apiPath);
  if (releaseMatch) {
    const before = state.releases.length;
    state.releases = state.releases.filter(release => String(release.id) !== releaseMatch[1]);
    if (state.releases.length === before) fail('gh: Not Found (HTTP 404)');
    return save();
  }
  if (method === 'DELETE' && apiPath === `${repoPath}/git/refs/tags/${state.tag}`) {
    if (!state.tagSha) fail('gh: Reference does not exist (HTTP 422)');
    if (state.tagDeleteRefused) fail('gh: Repository rule violations found (HTTP 422)');
    state.tagSha = null;
    return save();
  }
  fail(`unexpected gh api call: ${args.join(' ')}`);
}

function runRelease() {
  const knowsRepo = process.env.GH_REPO === state.repo || process.env.FAKE_CHECKOUT_REPO === state.repo;
  if (!knowsRepo) fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git');
  const [command, tag] = args;
  if (tag !== state.tag) fail(`unexpected gh release call: ${args.join(' ')}`);
  if (state.apiError) fail(state.apiError);
  const release = findRelease();

  if (command === 'view') {
    if (!release) fail('release not found');
    return print({ assets: release.assets.map(name => ({ name })) }, optionValue(['--jq', '-q']));
  }
  if (command === 'create') {
    const created = {
      id: Math.max(0, ...state.releases.map(existing => existing.id)) + 1,
      draft: true,
      target: optionValue(['--target']),
      assets: []
    };
    state.releases.push(created);
    if (!args.includes('--draft')) publish(created);
    return save();
  }
  if (!release) fail('release not found');
  if (command === 'edit') {
    release.target = optionValue(['--target']) || release.target;
    if (args.includes('--draft=false')) publish(release);
    return save();
  }
  if (command === 'upload') {
    release.assets = [...new Set([...release.assets, ...args.slice(2).filter(arg => !arg.startsWith('-'))])];
    return save();
  }
  if (command === 'delete-asset') {
    release.assets = release.assets.filter(name => name !== args[2]);
    return save();
  }
  if (command === 'delete' && args.includes('--yes')) {
    state.releases = state.releases.filter(existing => existing !== release);
    save();
    if (args.includes('--cleanup-tag')) {
      if (state.tagDeleteRefused)
        fail(`failed to delete tag tags/${state.tag}: Repository rule violations found (HTTP 422)`);
      state.tagSha = null;
      save();
    }
    return undefined;
  }
  fail(`unexpected gh release call: ${args.join(' ')}`);
}

if (tool === 'git' && args[0] === 'ls-remote' && args.includes('--tags')) {
  if (state.tagSha) process.stdout.write(`${state.tagSha}\trefs/tags/${state.tag}\n`);
} else if (tool === 'gh' && args[0] === 'api') {
  args.shift();
  runApi();
} else if (tool === 'gh' && args[0] === 'release') {
  args.shift();
  runRelease();
} else {
  process.stderr.write(`unexpected ${tool} call: ${args.join(' ')}\n`);
  process.exit(99);
}
