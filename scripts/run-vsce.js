const { spawnSync } = require('child_process');
const { cpSync, existsSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');

const repoRoot = resolve(__dirname, '..');
const extensionPackageDir = join(repoRoot, 'apps', 'vscode-extension');

function resolveVsceInvocation(platformValue = process.platform) {
  const localBinary = join(repoRoot, 'node_modules', '.bin', platformValue === 'win32' ? 'vsce.cmd' : 'vsce');
  if (existsSync(localBinary)) {
    return { command: localBinary, baseArgs: [] };
  }
  return { command: 'npx', baseArgs: ['--yes', '@vscode/vsce'] };
}

function addRepoLocalBinToPath(env = process.env) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const localBin = join(repoRoot, 'node_modules', '.bin');
  const currentPath = String(env.PATH || '');
  if (currentPath.split(delimiter).includes(localBin)) {
    return currentPath;
  }
  return `${localBin}${delimiter}${currentPath}`;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function normalizePathArgs(args, baseDir = repoRoot) {
  const normalized = [...args];
  for (let index = 0; index < normalized.length; index += 1) {
    if ((normalized[index] === '--out' || normalized[index] === '--packagePath') && normalized[index + 1]) {
      normalized[index + 1] = resolve(baseDir, normalized[index + 1]);
      index += 1;
    }
  }
  return normalized;
}

function createPackagingStage() {
  const stageDir = mkdtempSync(join(tmpdir(), 'alv-vsce-stage-'));
  cpSync(extensionPackageDir, stageDir, { recursive: true });
  return stageDir;
}

function runVsce(rawArgs, options = {}) {
  const args = [...rawArgs];
  const skipPrepublishIndex = args.indexOf('--skip-prepublish');
  const skipPrepublish = skipPrepublishIndex >= 0;
  if (skipPrepublish) {
    args.splice(skipPrepublishIndex, 1);
  }

  const command = args[0];
  if (!command) {
    throw new Error('usage: node scripts/run-vsce.js <package|publish> [args]');
  }

  const env = {
    ...process.env,
    PATH: addRepoLocalBinToPath({ ...process.env, ...(options.env || {}) }),
    ...(options.env || {})
  };

  if (!skipPrepublish && (command === 'package' || command === 'publish')) {
    runCommand('npm', ['run', 'package'], { cwd: repoRoot, env });
  }

  const invocation = resolveVsceInvocation();
  const normalizedArgs = normalizePathArgs(args);
  const stageDir = command === 'package' || command === 'publish' ? createPackagingStage() : extensionPackageDir;

  try {
    runCommand(invocation.command, [...invocation.baseArgs, ...normalizedArgs], {
      cwd: stageDir,
      env
    });
  } finally {
    if (stageDir !== extensionPackageDir) {
      rmSync(stageDir, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    runVsce(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  addRepoLocalBinToPath,
  extensionPackageDir,
  repoRoot,
  createPackagingStage,
  normalizePathArgs,
  resolveVsceInvocation,
  runVsce
};
