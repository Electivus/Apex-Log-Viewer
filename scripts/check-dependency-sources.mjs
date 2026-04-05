import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedGitDependencies = new Map([
  [
    'tree-sitter-sfapex',
    'git+https://github.com/manoelcalixto/tree-sitter-sfapex.git#685c57c5461eb247d019b244f2130e198c7cc706'
  ]
]);
const disallowedPrefixes = ['git+', 'github:', 'http://', 'https://', 'file:', 'link:'];

function collectManifestPaths(baseDir) {
  const dirPath = path.join(repoRoot, baseDir);
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dirPath, entry.name, 'package.json'))
    .filter(filePath => fs.existsSync(filePath));
}

function manifests() {
  return [
    path.join(repoRoot, 'package.json'),
    ...collectManifestPaths('apps'),
    ...collectManifestPaths('packages')
  ];
}

const failures = [];

for (const manifestPath of manifests()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies !== 'object') {
      continue;
    }

    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== 'string' || version.startsWith('workspace:')) {
        continue;
      }

      const hasBlockedSource = disallowedPrefixes.some(prefix => version.startsWith(prefix));
      const allowedPinnedGit = allowedGitDependencies.get(name) === version;
      if (hasBlockedSource && !allowedPinnedGit) {
        failures.push(`${path.relative(repoRoot, manifestPath)} -> ${name}@${version}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Disallowed dependency sources found:');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}
