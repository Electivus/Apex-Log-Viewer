const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const spawn = require('cross-spawn');

const repoRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawn.sync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    ...options
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout;
}

async function files(root, prefix = '') {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(path.join(root, entry.name), `${relative}/`)));
    else found.push(relative);
  }
  return found.sort();
}

test(
  'npm tarball installs bundled skills outside the checkout with network and subprocesses denied',
  { timeout: 180_000 },
  async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-skill-package-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    run('pnpm', ['run', 'build:sf-plugin']);
    const { stageSfPluginPackage } = await import(
      pathToFileURL(path.join(__dirname, 'stage-sf-plugin-npm-package.mjs')).href
    );
    const staged = path.join(temporary, 'staged');
    await stageSfPluginPackage({ repoRoot, outDir: staged });
    const packed = JSON.parse(
      run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: staged })
    )[0];
    const canonicalFiles = await files(path.join(repoRoot, 'skills'));
    for (const file of canonicalFiles)
      assert.ok(
        packed.files.some(entry => entry.path === `skills/${file}`),
        file
      );
    assert.ok(packed.files.some(entry => entry.path === 'node_modules/@alv/core/lib/index.js'));
    assert.ok(packed.files.some(entry => entry.path === 'README.md'));
    // GNU tar interprets a Windows drive colon as a remote host; use a local filename.
    run('tar', ['-xzf', packed.filename], { cwd: temporary });
    const extracted = path.join(temporary, 'package');
    const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8'));
    assert.equal(manifest.private, undefined);
    for (const file of canonicalFiles) {
      assert.deepEqual(
        await fs.readFile(path.join(extracted, 'skills', file)),
        await fs.readFile(path.join(repoRoot, 'skills', file))
      );
    }
    // Resolve external runtime dependencies from the frozen workspace install, not a registry.
    // The plugin code, manifest, core bundle and skills themselves must come from the tarball.
    for (const [target, source] of [
      [extracted, path.join(repoRoot, 'packages/sf-plugin')],
      [path.join(extracted, 'node_modules/@alv/core'), path.join(repoRoot, 'packages/core')]
    ]) {
      const pkg = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
      for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (name === '@alv/core') continue;
        const link = path.join(target, 'node_modules', name);
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(
          await fs.realpath(path.join(source, 'node_modules', name)),
          link,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
    }
    const guard = path.join(temporary, 'deny-network.cjs');
    await fs.writeFile(
      guard,
      `
const deny = () => { throw new Error('OFFLINE TEST: network/subprocess attempted'); };
for (const [module, methods] of Object.entries({
  'node:http': ['request', 'get'], 'node:https': ['request', 'get'],
  'node:net': ['connect', 'createConnection'], 'node:tls': ['connect'],
  'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
})) for (const method of methods) require(module)[method] = deny;
require('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();
`
    );
    const workspace = path.join(temporary, 'project with spaces');
    await fs.mkdir(workspace);
    const env = { ...process.env, CI: '1', SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true' };
    const args = ['--require', guard, path.join(extracted, 'bin/run.js'), 'electivus', 'skill', 'install'];
    const result = JSON.parse(
      run(
        process.execPath,
        [...args, '--agent', 'codex', '--agent', 'github-copilot', '--agent', 'claude-code', '--json'],
        { cwd: workspace, env }
      )
    );
    assert.equal(result.status, 0);
    assert.equal(result.result.installations.length, 2);
    assert.equal(
      await fs.realpath(result.result.source),
      await fs.realpath(path.join(extracted, 'skills/apex-log-viewer-cli'))
    );
    for (const installation of result.result.installations) {
      assert.equal(installation.status, 'installed');
      await fs.access(path.join(installation.destination, 'agents/openai.yaml'));
    }
    const noSelection = spawn.sync(process.execPath, [...args, '--json'], {
      cwd: workspace,
      env,
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.notEqual(noSelection.status, 0);
    assert.match(JSON.parse(noSelection.stdout).message, /Specify --agent or --skills-dir/);
    const legacy = JSON.parse(
      run(process.execPath, [...args, '--codex-home', path.join(temporary, 'legacy'), '--json'], {
        cwd: workspace,
        env
      })
    );
    assert.equal(legacy.result.installations[0].destination, path.join(temporary, 'legacy/skills/apex-log-viewer-cli'));
    const catalog = JSON.parse(
      run(process.execPath, [...args, '--agent', 'codex', '--all', '--json'], { cwd: workspace, env })
    );
    assert.equal(catalog.status, 0);
    assert.deepEqual(
      catalog.result.skills.map(item => item.skillName),
      ['apex-log-viewer-cli', 'apex-debug-investigate', 'apex-debug-performance']
    );
    for (const item of catalog.result.skills) {
      for (const file of item.files)
        assert.deepEqual(
          await fs.readFile(path.join(item.installations[0].destination, file)),
          await fs.readFile(path.join(item.source, file))
        );
    }
    const selected = JSON.parse(
      run(process.execPath, [...args, '--agent', 'claude-code', '--skill', 'apex-debug-performance', '--json'], {
        cwd: workspace,
        env
      })
    );
    assert.equal(selected.result.skills.length, 1);
    assert.equal(selected.result.skills[0].skillName, 'apex-debug-performance');
  }
);

test('rebuilding skill artifacts removes stale files and includes supporting resources', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-skill-copy-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'skills/apex-log-viewer-cli');
  await fs.mkdir(path.join(source, 'references'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: apex-log-viewer-cli\ndescription: Test catalog\n---\n');
  await fs.writeFile(path.join(source, 'references/example.md'), 'supporting content');
  const { copySfPluginSkills } = await import(pathToFileURL(path.join(__dirname, 'copy-sf-plugin-skills.mjs')).href);
  await copySfPluginSkills(temporary);
  const output = path.join(temporary, 'packages/sf-plugin/skills');
  await fs.writeFile(path.join(output, 'stale.md'), 'stale');
  await copySfPluginSkills(temporary);
  assert.deepEqual(await files(output), ['apex-log-viewer-cli/SKILL.md', 'apex-log-viewer-cli/references/example.md']);
  await fs.rm(path.join(source, 'SKILL.md'));
  await assert.rejects(copySfPluginSkills(temporary), /ENOENT/);
});
