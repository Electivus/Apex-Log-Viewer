import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RIPGREP_PACKAGE_BY_TARGET = {
  'darwin-arm64': 'ripgrep-darwin-arm64',
  'darwin-x64': 'ripgrep-darwin-x64',
  'linux-arm': 'ripgrep-linux-arm',
  'linux-arm64': 'ripgrep-linux-arm64',
  'linux-ia32': 'ripgrep-linux-ia32',
  'linux-ppc64': 'ripgrep-linux-ppc64',
  'linux-riscv64': 'ripgrep-linux-riscv64',
  'linux-s390x': 'ripgrep-linux-s390x',
  'linux-x64': 'ripgrep-linux-x64',
  'win32-arm64': 'ripgrep-win32-arm64',
  'win32-ia32': 'ripgrep-win32-ia32',
  'win32-x64': 'ripgrep-win32-x64'
};

function npmInstallInvocation({ platform, args }) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...args]
    };
  }

  return {
    command: 'npm',
    args
  };
}

function targetPackageName(target) {
  const normalized = typeof target === 'string' ? target.trim() : '';
  if (!normalized) {
    return undefined;
  }
  const packageName = RIPGREP_PACKAGE_BY_TARGET[normalized];
  if (!packageName) {
    throw new Error(`unsupported ripgrep VSIX target: ${normalized}`);
  }
  return packageName;
}

function readRipgrepMetaPackage(sourceNamespaceRoot) {
  const packageJsonPath = path.join(sourceNamespaceRoot, 'ripgrep', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`ripgrep runtime package not found under ${sourceNamespaceRoot}`);
  }
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function ensureRipgrepPackage({ repoRoot, sourceNamespaceRoot, packageName, version, execFileSyncFn, platform }) {
  const packageRoot = path.join(sourceNamespaceRoot, packageName);
  if (fs.existsSync(packageRoot)) {
    return;
  }

  const installArgs = [
    'install',
    '--no-save',
    '--package-lock=false',
    '--ignore-scripts',
    '--force',
    '--workspaces=false',
    `@vscode/${packageName}@${version}`
  ];
  const invocation = npmInstallInvocation({ platform, args: installArgs });

  execFileSyncFn(invocation.command, invocation.args, { cwd: repoRoot, stdio: 'inherit' });

  if (!fs.existsSync(packageRoot)) {
    throw new Error(`failed to install @vscode/${packageName}@${version}`);
  }
}

export function copyRipgrepRuntime({ repoRoot, target, execFileSyncFn = execFileSync, platform = process.platform }) {
  const sourceNamespaceRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const destinationNamespaceRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode');

  if (!fs.existsSync(sourceNamespaceRoot)) {
    throw new Error(`@vscode package namespace not found at ${sourceNamespaceRoot}`);
  }

  const metaPackage = readRipgrepMetaPackage(sourceNamespaceRoot);
  const requestedPackage = targetPackageName(target);
  const packages = requestedPackage
    ? ['ripgrep', requestedPackage]
    : fs
        .readdirSync(sourceNamespaceRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^ripgrep(?:-|$)/.test(entry.name))
        .map(entry => entry.name)
        .sort();

  if (!packages.includes('ripgrep')) {
    throw new Error(`ripgrep runtime package not found under ${sourceNamespaceRoot}`);
  }

  if (requestedPackage) {
    const version = metaPackage.optionalDependencies?.[`@vscode/${requestedPackage}`] ?? metaPackage.version;
    ensureRipgrepPackage({
      repoRoot,
      sourceNamespaceRoot,
      packageName: requestedPackage,
      version,
      execFileSyncFn,
      platform
    });
  }

  fs.mkdirSync(destinationNamespaceRoot, { recursive: true });
  for (const entry of fs.readdirSync(destinationNamespaceRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^ripgrep(?:-|$)/.test(entry.name)) {
      fs.rmSync(path.join(destinationNamespaceRoot, entry.name), { recursive: true, force: true });
    }
  }

  for (const packageName of packages) {
    const sourceRoot = path.join(sourceNamespaceRoot, packageName);
    const destinationRoot = path.join(destinationNamespaceRoot, packageName);
    fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
  }

  return { destinationNamespaceRoot, packages };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyRipgrepRuntime({
    repoRoot,
    target: process.argv[2] || process.env.ALV_RIPGREP_TARGET || process.env.MATRIX_TARGET
  });
}
