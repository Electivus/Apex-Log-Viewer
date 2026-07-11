import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RIPGREP_PACKAGE_BY_TARGET = {
  'darwin-arm64': 'ripgrep-darwin-arm64',
  'darwin-x64': 'ripgrep-darwin-x64',
  'linux-arm64': 'ripgrep-linux-arm64',
  'linux-x64': 'ripgrep-linux-x64',
  'win32-arm64': 'ripgrep-win32-arm64',
  'win32-x64': 'ripgrep-win32-x64'
};

const require = createRequire(import.meta.url);

function resolveRipgrepNamespaceRoot(repoRoot) {
  const virtualStoreRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(virtualStoreRoot)) {
    const virtualStoreCandidates = fs
      .readdirSync(virtualStoreRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^@vscode\+ripgrep@/.test(entry.name))
      .map(entry => path.join(virtualStoreRoot, entry.name, 'node_modules', '@vscode'))
      .filter(namespaceRoot => fs.existsSync(path.join(namespaceRoot, 'ripgrep', 'package.json')))
      .sort();
    if (virtualStoreCandidates.length > 0) return virtualStoreCandidates.at(-1);
  }

  const extensionRoot = path.join(repoRoot, 'apps', 'vscode-extension');
  for (const namespaceRoot of [
    path.join(repoRoot, 'node_modules', '@vscode'),
    path.join(extensionRoot, 'node_modules', '@vscode')
  ]) {
    if (fs.existsSync(path.join(namespaceRoot, 'ripgrep', 'package.json'))) {
      return path.dirname(fs.realpathSync(path.join(namespaceRoot, 'ripgrep')));
    }
  }

  let packageRoot = path.dirname(require.resolve('@vscode/ripgrep', { paths: [repoRoot, extensionRoot] }));
  while (!fs.existsSync(path.join(packageRoot, 'package.json'))) {
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) throw new Error('unable to resolve the @vscode/ripgrep package root');
    packageRoot = parent;
  }
  return path.dirname(fs.realpathSync(packageRoot));
}

function targetPackageName(target) {
  const normalized = typeof target === 'string' ? target.trim() : '';
  if (!normalized) return undefined;
  const packageName = RIPGREP_PACKAGE_BY_TARGET[normalized];
  if (!packageName) throw new Error(`unsupported ripgrep VSIX target: ${normalized}`);
  return packageName;
}

function readRipgrepMetaPackage(sourceNamespaceRoot) {
  const packageJsonPath = path.join(sourceNamespaceRoot, 'ripgrep', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`ripgrep runtime package not found under ${sourceNamespaceRoot}`);
  }
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function assertRipgrepPackageInstalled({ sourceNamespaceRoot, packageName, version }) {
  const packageRoot = path.join(sourceNamespaceRoot, packageName);
  if (fs.existsSync(packageRoot)) return packageRoot;
  throw new Error(
    `missing @vscode/${packageName}@${version}; run pnpm install --frozen-lockfile so pnpm materializes the configured supportedArchitectures`
  );
}

export function copyRipgrepRuntime({ repoRoot, target }) {
  const sourceNamespaceRoot = resolveRipgrepNamespaceRoot(repoRoot);
  const destinationRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'ripgrep');
  const metaPackage = readRipgrepMetaPackage(sourceNamespaceRoot);
  const requestedPackage = targetPackageName(target);
  const targetEntries = Object.entries(RIPGREP_PACKAGE_BY_TARGET).filter(([, packageName]) =>
    requestedPackage ? packageName === requestedPackage : fs.existsSync(path.join(sourceNamespaceRoot, packageName))
  );
  if (targetEntries.length === 0) {
    throw new Error(`no supported ripgrep runtime packages found under ${sourceNamespaceRoot}`);
  }

  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  const packages = [];
  for (const [targetName, packageName] of targetEntries) {
    const version = metaPackage.optionalDependencies?.[`@vscode/${packageName}`] ?? metaPackage.version;
    const sourceRoot = assertRipgrepPackageInstalled({ sourceNamespaceRoot, packageName, version });
    fs.cpSync(fs.realpathSync(sourceRoot), path.join(destinationRoot, targetName), { recursive: true });
    packages.push(packageName);
  }

  return { destinationRoot, packages };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyRipgrepRuntime({
    repoRoot,
    target:
      process.argv.slice(2).find(argument => argument !== '--') ||
      process.env.ALV_RIPGREP_TARGET ||
      process.env.MATRIX_TARGET
  });
}
