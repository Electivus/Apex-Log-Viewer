import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularTree, readSkillCatalog } from './agent-skill-catalog.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function agentPluginFiles(repoRoot = defaultRoot) {
  const { plugin, mcp } = JSON.parse(await fs.readFile(path.join(repoRoot, 'config/agent-plugin.json'), 'utf8'));
  if (plugin.name !== 'electivus-debug') throw new Error('Expected electivus-debug package identity.');
  const source = path.join(repoRoot, 'skills');
  await readSkillCatalog(source);
  const files = new Map();
  for (const [name, body] of await readRegularTree(source)) files.set(`skills/${name}`, body);
  files.set('plugin.json', json(plugin));
  files.set('mcp.json', json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: mcp }));
  const { $schema: _schema, ...identity } = plugin;
  const legacy = { ...identity, skills: './skills/', mcpServers: './.mcp.json' };
  files.set('.claude-plugin/plugin.json', json(legacy));
  files.set(
    '.codex-plugin/plugin.json',
    json({
      ...legacy,
      interface: {
        displayName: 'Electivus Debug',
        shortDescription: 'Investigate Salesforce logs locally',
        longDescription: plugin.description,
        developerName: 'Electivus',
        category: 'Productivity',
        capabilities: ['Interactive'],
        defaultPrompt: ['Find the relevant Salesforce transaction in my local logs and investigate the failure.']
      }
    })
  );
  files.set(
    '.mcp.json',
    json({
      mcpServers: Object.fromEntries(Object.entries(mcp).map(([name, { type: _type, ...server }]) => [name, server]))
    })
  );
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const notice = await fs.readFile(path.join(repoRoot, name), 'utf8');
    files.set(name, Buffer.from(`${notice.trimEnd()}\n`));
  }
  files.set(
    'README.md',
    Buffer.from(
      `# Electivus Debug\n\nGenerated from the repository's canonical skills and config/agent-plugin.json. Do not edit this bundle by hand.\n\nSynchronize available Salesforce logs with sf electivus, search the local corpus, then investigate selected executions. Includes three standalone skills and the optional Certinia analyzer configured for analysis only.\n\nRequires local Node.js 22.19+ (Node 24 recommended), Salesforce CLI with @electivus/plugin-electivus for org capture, and ripgrep or the agent's equivalent local search tools. The first MCP start downloads @certinia/apex-log-mcp@2.0.1 from npm; this bundle is not an offline MCP runtime.\n\n[Installation, updates and validation](https://github.com/Electivus/Apex-Log-Viewer/blob/main/docs/AGENT-SKILL.md)\n`
    )
  );
  return { plugin, files };
}

export async function buildAgentPlugin({ repoRoot = defaultRoot, check = false } = {}) {
  const { plugin, files } = await agentPluginFiles(repoRoot);
  const destination = path.join(repoRoot, 'plugins', plugin.name);
  const catalogs = new Map([
    [
      '.agents/plugins/marketplace.json',
      json({
        name: 'electivus',
        interface: { displayName: 'Electivus' },
        plugins: [
          {
            name: plugin.name,
            source: { source: 'local', path: `./plugins/${plugin.name}` },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity'
          }
        ]
      })
    ],
    [
      '.claude-plugin/marketplace.json',
      json({
        name: 'electivus',
        description: 'Salesforce debugging skills and local log analysis from Electivus.',
        owner: { name: 'Electivus' },
        plugins: [
          {
            name: plugin.name,
            source: `./plugins/${plugin.name}`,
            description: plugin.description,
            version: plugin.version
          }
        ]
      })
    ]
  ]);
  if (check) {
    const actual = await readRegularTree(destination);
    if (actual.size !== files.size || [...files].some(([name, body]) => !actual.get(name)?.equals(body))) {
      throw new Error('Agent plugin bundle is stale; run pnpm run build:agent-plugin.');
    }
    for (const [name, body] of catalogs) {
      if (!(await fs.readFile(path.join(repoRoot, name))).equals(body)) throw new Error(`Stale marketplace: ${name}`);
    }
  } else {
    // This directory contains generated artifacts only. Reject redirects before replacement.
    try {
      await readRegularTree(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rm(destination, { recursive: true, force: true });
    for (const [name, body] of files) {
      const target = path.join(destination, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
    for (const [name, body] of catalogs) {
      const target = path.join(repoRoot, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    }
  }
  return { destination, fileCount: files.size, version: plugin.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--check');
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  console.log(JSON.stringify(await buildAgentPlugin({ check: process.argv.includes('--check') })));
}
