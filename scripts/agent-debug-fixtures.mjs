import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = JSON.parse(
  await fs.readFile(new URL('../test/agent-debug/corpus.json', import.meta.url), 'utf8')
);

export async function materializeDebugCorpus(workspace) {
  const apexlogsRoot = path.join(workspace, 'apexlogs');
  const orgLogsRoot = path.join(apexlogsRoot, 'orgs', fixture.org, 'logs');
  const dayRoot = path.join(orgLogsRoot, '2026-09-21');
  await fs.mkdir(dayRoot, { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.gitignore'), 'apexlogs/\n*.log\n');
  const paths = {};
  for (const scenario of fixture.cases) {
    const target = path.join(dayRoot, `${scenario.logId}.log`);
    await fs.writeFile(target, `${scenario.lines.join('\n')}\n`);
    paths[scenario.id] = target;
  }
  // A large candidate set with a content-free filename ordering distraction.
  for (let index = 200; index < 260; index++) {
    await fs.writeFile(
      path.join(dayRoot, `07L${String(index).padStart(12, '0')}AAA.log`),
      '12:00:00.0|USER_DEBUG|[1]|DEBUG|OTHER-ORDER\n'
    );
  }
  const first = fixture.cases[0];
  await fs.copyFile(paths[first.id], path.join(apexlogsRoot, `${fixture.org}_${first.logId}.log`));
  const legacyOnlyId = '07L000000000099AAA';
  await fs.writeFile(
    path.join(apexlogsRoot, `${fixture.org}_${legacyOnlyId}.log`),
    '12:00:00.0|USER_DEBUG|[1]|DEBUG|ORDER-4821 asyncJob=707000000000001AAA enqueued\n'
  );
  const other = path.join(apexlogsRoot, 'orgs', 'other@example.com', 'logs', '2026-09-21');
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(
    path.join(other, '07L000000000999AAA.log'),
    '12:00:00.0|FATAL_ERROR|ORDER-4821 unrelated failure in another org\n'
  );
  for (const [name, body] of Object.entries(fixture.sources)) await fs.writeFile(path.join(workspace, name), body);
  return { apexlogsRoot, orgLogsRoot, paths, legacyOnlyId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/agent-debug-fixtures.mjs <empty-workspace>');
  const workspace = path.resolve(process.argv[2]);
  await fs.mkdir(workspace, { recursive: true });
  if ((await fs.readdir(workspace)).length) throw new Error('The fixture workspace must be empty.');
  console.log(JSON.stringify(await materializeDebugCorpus(workspace), null, 2));
}
