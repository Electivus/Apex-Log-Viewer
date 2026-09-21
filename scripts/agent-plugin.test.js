const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
