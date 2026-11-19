const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const repoRoot = path.resolve(__dirname, '..');
const load = name => import(pathToFileURL(path.join(__dirname, name)).href);

test('committed plugin is self-contained, current, and exposes one identical MCP per format', async () => {
  const { buildAgentPlugin, agentPluginFiles } = await load('build-agent-plugin.mjs');
  await buildAgentPlugin({ check: true });
  const { plugin, files } = await agentPluginFiles();
  const portable = JSON.parse(files.get('mcp.json'));
  const legacy = JSON.parse(files.get('.mcp.json'));
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(portable.mcpServers), ['apex-log-mcp']);
  const { type, ...server } = portable.mcpServers['apex-log-mcp'];
  assert.equal(type, 'stdio');
  assert.deepEqual(server, legacy.mcpServers['apex-log-mcp']);
  assert.deepEqual(server.args, ['-y', '@certinia/apex-log-mcp@2.0.1', '--no-apex-execution']);
  for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = JSON.parse(files.get(name));
    assert.equal(manifest.name, plugin.name);
    assert.equal(manifest.version, plugin.version);
    assert.equal(manifest.mcpServers, './.mcp.json');
  }
  const { readSkillCatalog } = await load('agent-skill-catalog.mjs');
  const names = await readSkillCatalog(path.join(repoRoot, 'skills'));
  assert.deepEqual(names, ['apex-debug-investigate', 'apex-debug-performance', 'apex-log-viewer-cli']);
  // Each portable skill can be installed alone: references stay within its own directory.
  for (const [name, body] of files) {
    if (!name.startsWith('skills/') || !name.endsWith('.md')) continue;
    const skillRoot = name.split('/').slice(0, 2).join('/');
    for (const match of body.toString().matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^https?:/.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      assert.ok(resolved.startsWith(`${skillRoot}/`), `${name}: reference escapes standalone skill`);
      assert.ok(files.has(resolved), `${name}: missing ${resolved}`);
    }
  }
});

test('generation detects stale content and removes stale bundle files on rebuild', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-agent-build-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const name of ['config', 'skills'])
    await fs.cp(path.join(repoRoot, name), path.join(temporary, name), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await fs.copyFile(path.join(repoRoot, name), path.join(temporary, name));
  const { buildAgentPlugin } = await load('build-agent-plugin.mjs');
  const result = await buildAgentPlugin({ repoRoot: temporary });
  await fs.writeFile(path.join(result.destination, 'stale.md'), 'stale');
  await assert.rejects(buildAgentPlugin({ repoRoot: temporary, check: true }), /stale/);
  await buildAgentPlugin({ repoRoot: temporary });
  await buildAgentPlugin({ repoRoot: temporary, check: true });
  await assert.rejects(fs.access(path.join(result.destination, 'stale.md')));
});

test('a Windows-style Git checkout preserves generated plugin freshness', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-agent-checkout-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const name of ['config', 'skills'])
    await fs.cp(path.join(repoRoot, name), path.join(temporary, name), { recursive: true });
  for (const name of ['.gitattributes', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await fs.copyFile(path.join(repoRoot, name), path.join(temporary, name));
  const { buildAgentPlugin } = await load('build-agent-plugin.mjs');
  const { destination } = await buildAgentPlugin({ repoRoot: temporary });
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=crlf', ...args], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  };
  git(['init', '--quiet']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Electivus Tests',
    '-c',
    'user.email=tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Fixture'
  ]);
  // Remove both notices so Git must materialize their configured checkout line endings.
  await fs.rm(path.join(temporary, 'LICENSE'));
  await fs.rm(path.join(destination, 'LICENSE'));
  git(['checkout', 'HEAD', '--', 'LICENSE', 'plugins/electivus-debug/LICENSE']);
  await buildAgentPlugin({ repoRoot: temporary, check: true });
});

test('the analyzer smoke run lets npx resolve only packages past the repository release age', async () => {
  const yaml = require('yaml');
  const workspace = yaml.parse(await fs.readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const windowMs = workspace.minimumReleaseAge * 60 * 1000;
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-npx-stub-'));
  const record = path.join(bin, 'before.json');
  try {
    // A stub npx records the npm config the smoke script hands it, then exits like a broken server.
    await fs.writeFile(
      path.join(bin, 'stub.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env.npm_config_before ?? null)); process.exit(1);`
    );
    await fs.writeFile(
      path.join(bin, 'npx'),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'stub.cjs')}"\n`,
      { mode: 0o755 }
    );
    await fs.writeFile(path.join(bin, 'npx.cmd'), `@"${process.execPath}" "${path.join(bin, 'stub.cjs')}"\r\n`);
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
    const started = Date.now();
    spawnSync(process.execPath, [path.join(__dirname, 'test-agent-plugin-mcp.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}` },
      encoding: 'utf8',
      timeout: 60000
    });
    const finished = Date.now();
    const before = JSON.parse(await fs.readFile(record, 'utf8'));
    assert.equal(typeof before, 'string', 'the smoke script must pass npm a before= cutoff');
    const cutoff = Date.parse(before);
    assert.ok(cutoff >= started - windowMs - 1000 && cutoff <= finished - windowMs, `cutoff ${before}`);
  } finally {
    await fs.rm(bin, { recursive: true, force: true });
  }
});
