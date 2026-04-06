import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolveRepoRoot(process.argv.slice(2));
const treeSitterSfapexCommit = '685c57c5461eb247d019b244f2130e198c7cc706';
const allowedGitDependencies = new Map([
  [
    'tree-sitter-sfapex',
    {
      manifest: new Set([
        `git+https://github.com/manoelcalixto/tree-sitter-sfapex.git#${treeSitterSfapexCommit}`
      ]),
      lock: new Set([
        `git+https://github.com/manoelcalixto/tree-sitter-sfapex.git#${treeSitterSfapexCommit}`,
        `git+ssh://git@github.com/manoelcalixto/tree-sitter-sfapex.git#${treeSitterSfapexCommit}`
      ])
    }
  ]
]);
const disallowedPrefixes = ['git+', 'github:', 'http://', 'https://', 'file:', 'link:'];

function resolveRepoRoot(args) {
  const rootFlagIndex = args.indexOf('--root');
  if (rootFlagIndex === -1) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }

  const rootValue = args[rootFlagIndex + 1];
  if (!rootValue) {
    throw new Error('Missing path after --root');
  }
  return path.resolve(rootValue);
}

function collectWorkspacePaths(baseDir, fileName) {
  const dirPath = path.join(repoRoot, baseDir);
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dirPath, entry.name, fileName))
    .filter(filePath => fs.existsSync(filePath));
}

function manifests() {
  return [
    path.join(repoRoot, 'package.json'),
    ...collectWorkspacePaths('apps', 'package.json'),
    ...collectWorkspacePaths('packages', 'package.json')
  ];
}

function lockfiles() {
  return [
    path.join(repoRoot, 'package-lock.json'),
    ...collectWorkspacePaths('apps', 'package-lock.json'),
    ...collectWorkspacePaths('packages', 'package-lock.json')
  ].filter(filePath => fs.existsSync(filePath));
}

function hasBlockedManifestSource(version) {
  return disallowedPrefixes.some(prefix => version.startsWith(prefix));
}

function isAllowedManifestSource(name, version) {
  return allowedGitDependencies.get(name)?.manifest.has(version) === true;
}

function isAllowedLockSource(name, version) {
  return allowedGitDependencies.get(name)?.lock.has(version) === true;
}

function looksLikeUrl(value) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isRegistryTarball(resolved) {
  if (!looksLikeUrl(resolved)) {
    return false;
  }

  try {
    const url = new URL(resolved);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org';
  } catch {
    return false;
  }
}

function isPathInsideRepo(candidatePath) {
  const relativePath = path.relative(repoRoot, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isWorkspaceLink(resolved) {
  if (looksLikeUrl(resolved) || path.isAbsolute(resolved)) {
    return false;
  }

  const resolvedPath = path.resolve(repoRoot, resolved);
  return isPathInsideRepo(resolvedPath) && fs.existsSync(resolvedPath);
}

function lockEntryName(packagePath, packageMeta) {
  if (typeof packageMeta.name === 'string' && packageMeta.name.trim()) {
    return packageMeta.name.trim();
  }
  if (!packagePath) {
    return '(root)';
  }

  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return packagePath;
  }

  return packagePath.slice(markerIndex + marker.length);
}

function collectLegacyLockEntries(dependencies, trail = []) {
  if (!dependencies || typeof dependencies !== 'object') {
    return [];
  }

  const entries = [];
  for (const [name, packageMeta] of Object.entries(dependencies)) {
    if (!packageMeta || typeof packageMeta !== 'object') {
      continue;
    }

    const dependencyPath = trail.length === 0 ? name : `${trail.join(' > ')} > ${name}`;
    entries.push({ dependencyPath, name, packageMeta });
    entries.push(...collectLegacyLockEntries(packageMeta.dependencies, [...trail, name]));
  }
  return entries;
}

function legacyLockSource(packageMeta) {
  const resolved = typeof packageMeta.resolved === 'string' ? packageMeta.resolved.trim() : '';
  if (resolved) {
    return resolved;
  }

  const version = typeof packageMeta.version === 'string' ? packageMeta.version.trim() : '';
  return looksLikeUrl(version) ? version : '';
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

      if (hasBlockedManifestSource(version) && !isAllowedManifestSource(name, version)) {
        failures.push(`${path.relative(repoRoot, manifestPath)} -> ${name}@${version}`);
      }
    }
  }
}

for (const lockfilePath of lockfiles()) {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  if (lockfile.packages && typeof lockfile.packages === 'object') {
    for (const [packagePath, packageMeta] of Object.entries(lockfile.packages)) {
      if (!packageMeta || typeof packageMeta !== 'object') {
        continue;
      }

      const resolved = typeof packageMeta.resolved === 'string' ? packageMeta.resolved.trim() : '';
      if (!resolved) {
        continue;
      }

      const packageName = lockEntryName(packagePath, packageMeta);
      const allowed =
        isAllowedLockSource(packageName, resolved) ||
        (packageMeta.link === true && isWorkspaceLink(resolved)) ||
        isRegistryTarball(resolved);

      if (!allowed) {
        failures.push(`${path.relative(repoRoot, lockfilePath)} -> ${packagePath || '(root)'} -> ${resolved}`);
      }
    }
  }

  for (const { dependencyPath, name, packageMeta } of collectLegacyLockEntries(lockfile.dependencies)) {
    const source = legacyLockSource(packageMeta);
    if (!source) {
      continue;
    }

    const allowed =
      isAllowedLockSource(name, source) ||
      (packageMeta.link === true && isWorkspaceLink(source)) ||
      isRegistryTarball(source);

    if (!allowed) {
      failures.push(`${path.relative(repoRoot, lockfilePath)} -> ${dependencyPath} -> ${source}`);
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
