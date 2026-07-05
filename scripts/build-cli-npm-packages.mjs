import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const cliNpmRoot = path.join(repoRoot, 'packages', 'cli-npm');
const sfPluginRoot = path.join(repoRoot, 'packages', 'sf-plugin');
const PLUGIN_PACKAGE_NAME = '@electivus/plugin-electivus';

export const PACKAGE_BY_TARGET = {
  'linux-x64': '@electivus/apex-log-viewer-linux-x64',
  'linux-arm64': '@electivus/apex-log-viewer-linux-arm64',
  'darwin-x64': '@electivus/apex-log-viewer-darwin-x64',
  'darwin-arm64': '@electivus/apex-log-viewer-darwin-arm64',
  'win32-x64': '@electivus/apex-log-viewer-win32-x64',
  'win32-arm64': '@electivus/apex-log-viewer-win32-arm64'
};

const TARGET_METADATA = {
  'linux-x64': { os: 'linux', cpu: 'x64', binaryName: 'apex-log-viewer' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', binaryName: 'apex-log-viewer' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', binaryName: 'apex-log-viewer' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', binaryName: 'apex-log-viewer' },
  'win32-x64': { os: 'win32', cpu: 'x64', binaryName: 'apex-log-viewer.exe' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', binaryName: 'apex-log-viewer.exe' }
};

export function resolvePackageForTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  const packageName = PACKAGE_BY_TARGET[target];
  if (!packageName) {
    throw new Error(`Unsupported platform/arch target: ${target}`);
  }
  return packageName;
}

function renderTemplate(templateSource, replacements) {
  return Object.entries(replacements).reduce(
    (output, [token, value]) => output.replaceAll(token, value),
    templateSource
  );
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFile(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (mode !== undefined) {
    fs.chmodSync(destination, mode);
  }
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      copyFile(sourcePath, destinationPath);
    }
  }
}

function copyPluginManifest(source, destination, version) {
  const manifest = JSON.parse(readText(source));
  manifest.version = version;
  writeJson(destination, manifest);
}

export function discoverBinaries(rootDir = repoRoot) {
  const binaries = {};
  const baseDir = path.join(rootDir, 'apps', 'vscode-extension', 'bin');

  for (const [target, { binaryName }] of Object.entries(TARGET_METADATA)) {
    const binaryPath = path.join(baseDir, target, binaryName);
    if (fs.existsSync(binaryPath)) {
      binaries[target] = binaryPath;
    }
  }

  return binaries;
}

function nativeOptionalDependencies(version) {
  return Object.fromEntries(Object.values(PACKAGE_BY_TARGET).map(packageName => [packageName, version]));
}

function buildPluginPackage({ version, outDir, pluginRoot = sfPluginRoot }) {
  const pluginDir = path.join(outDir, 'plugin');
  const pluginPackagePath = path.join(pluginRoot, 'package.json');
  const pluginLibDir = path.join(pluginRoot, 'lib');
  const pluginRunBin = path.join(pluginRoot, 'bin', 'run.js');

  if (!fs.existsSync(pluginPackagePath)) {
    throw new Error(`Salesforce CLI plugin package.json does not exist: ${pluginPackagePath}`);
  }
  if (!fs.existsSync(pluginLibDir)) {
    throw new Error(`Salesforce CLI plugin build output does not exist: ${pluginLibDir}`);
  }
  if (!fs.existsSync(pluginRunBin)) {
    throw new Error(`Salesforce CLI plugin run bin does not exist: ${pluginRunBin}`);
  }

  fs.rmSync(pluginDir, { recursive: true, force: true });

  const pluginPackage = JSON.parse(readText(pluginPackagePath));
  pluginPackage.name = PLUGIN_PACKAGE_NAME;
  pluginPackage.version = version;
  delete pluginPackage.bin;
  pluginPackage.optionalDependencies = {
    ...(pluginPackage.optionalDependencies ?? {}),
    ...nativeOptionalDependencies(version)
  };
  pluginPackage.repository = {
    type: 'git',
    url: 'https://github.com/Electivus/Apex-Log-Viewer'
  };
  delete pluginPackage.private;
  delete pluginPackage.devDependencies;
  delete pluginPackage.scripts;

  writeJson(path.join(pluginDir, 'package.json'), pluginPackage);
  copyFile(pluginRunBin, path.join(pluginDir, 'bin', 'run.js'), 0o755);

  const pluginRunCmd = path.join(pluginRoot, 'bin', 'run.cmd');
  if (fs.existsSync(pluginRunCmd)) {
    copyFile(pluginRunCmd, path.join(pluginDir, 'bin', 'run.cmd'));
  }

  copyDirectory(pluginLibDir, path.join(pluginDir, 'lib'));
  copyDirectory(path.join(pluginRoot, 'messages'), path.join(pluginDir, 'messages'));

  const manifestSource = path.join(pluginRoot, 'oclif.manifest.json');
  if (fs.existsSync(manifestSource)) {
    copyPluginManifest(manifestSource, path.join(pluginDir, 'oclif.manifest.json'), version);
  }

  const lockSource = path.join(pluginRoot, 'oclif.lock');
  if (fs.existsSync(lockSource)) {
    copyFile(lockSource, path.join(pluginDir, 'oclif.lock'));
  }

  return pluginDir;
}

export function buildCliNpmPackages({ version, outDir, binaries, pluginRoot = sfPluginRoot }) {
  if (!version || typeof version !== 'string') {
    throw new Error('buildCliNpmPackages requires a version string');
  }
  if (!outDir || typeof outDir !== 'string') {
    throw new Error('buildCliNpmPackages requires an outDir');
  }
  if (!binaries || typeof binaries !== 'object' || Object.keys(binaries).length === 0) {
    throw new Error('buildCliNpmPackages requires at least one built binary');
  }

  const nativeTemplate = readText(path.join(cliNpmRoot, 'templates', 'package.native.json'));
  const validatedNativePackages = [];

  fs.rmSync(path.join(outDir, 'meta'), { recursive: true, force: true });
  const pluginDir = buildPluginPackage({ version, outDir, pluginRoot });

  for (const [target, binaryPath] of Object.entries(binaries)) {
    const targetMetadata = TARGET_METADATA[target];
    const packageName = PACKAGE_BY_TARGET[target];
    if (!targetMetadata || !packageName) {
      throw new Error(`Unsupported native package target: ${target}`);
    }
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary for target ${target} does not exist: ${binaryPath}`);
    }

    validatedNativePackages.push([target, binaryPath, targetMetadata, packageName]);
  }

  for (const target of Object.keys(TARGET_METADATA)) {
    fs.rmSync(path.join(outDir, target), { recursive: true, force: true });
  }

  const nativeDirs = {};
  for (const [target, binaryPath, targetMetadata, packageName] of validatedNativePackages) {
    const nativeDir = path.join(outDir, target);
    const nativePackage = JSON.parse(
      renderTemplate(nativeTemplate, {
        __PACKAGE_NAME__: packageName,
        __VERSION__: version,
        __OS__: targetMetadata.os,
        __CPU__: targetMetadata.cpu,
        __BINARY_NAME__: targetMetadata.binaryName
      })
    );

    writeJson(path.join(nativeDir, 'package.json'), nativePackage);
    copyFile(binaryPath, path.join(nativeDir, 'bin', targetMetadata.binaryName), 0o755);
    nativeDirs[target] = nativeDir;
  }

  return { outDir, pluginDir, nativeDirs };
}

function parseCliArgs(argv) {
  const binaries = {};
  let outDir = path.join(repoRoot, 'dist', 'cli-npm');
  let version;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--version') {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--binary') {
      const pair = argv[index + 1] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        throw new Error(`Invalid --binary argument: ${pair}`);
      }
      const target = pair.slice(0, separator);
      const binaryPath = pair.slice(separator + 1);
      binaries[target] = binaryPath;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { binaries, outDir, version };
}

function readCliVersion() {
  const cargoToml = readText(path.join(repoRoot, 'crates', 'alv-cli', 'Cargo.toml'));
  const match = cargoToml.match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error('Unable to read crates/alv-cli version');
  }
  return match[1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { binaries, outDir, version } = parseCliArgs(process.argv.slice(2));
  const result = buildCliNpmPackages({
    version: version ?? readCliVersion(),
    outDir,
    binaries: Object.keys(binaries).length > 0 ? binaries : discoverBinaries(repoRoot)
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
