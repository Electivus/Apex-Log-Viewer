import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function defaultRunCommand(args, options = {}) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

export function readPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!manifest.name || !manifest.version) {
    throw new Error(`expected ${manifestPath} to declare both name and version`);
  }

  return {
    name: manifest.name,
    version: manifest.version
  };
}

function formatCommandError(prefix, result) {
  const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return details ? `${prefix}\n${details}` : prefix;
}

export function packageVersionExists(name, version, { runCommand = defaultRunCommand } = {}) {
  const result = runCommand(['view', `${name}@${version}`, 'version', '--json']);

  if (result.status === 0) {
    return true;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  if (/\bE404\b|404 Not Found|No match found/i.test(output)) {
    return false;
  }

  throw new Error(
    formatCommandError(
      `npm view failed for ${name}@${version} with exit code ${result.status ?? 'null'}`,
      result
    )
  );
}

export function publishPackageIfNeeded(packageDir, {
  tag = 'latest',
  access = 'public',
  runCommand = defaultRunCommand,
  logger = console
} = {}) {
  const { name, version } = readPackageManifest(packageDir);

  if (packageVersionExists(name, version, { runCommand })) {
    logger.log(`Skipping npm publish for ${name}@${version}; version already exists.`);
    return { name, version, published: false };
  }

  const result = runCommand(
    ['publish', packageDir, '--tag', tag, '--access', access],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(
      formatCommandError(
        `npm publish failed for ${name}@${version} with exit code ${result.status ?? 'null'}`,
        result
      )
    );
  }

  logger.log(`Published ${name}@${version}.`);
  return { name, version, published: true };
}

function parseArgs(argv) {
  const [packageDir, ...rest] = argv;

  if (!packageDir) {
    throw new Error('usage: node scripts/publish-npm-package-if-needed.mjs <package-dir> [--tag <tag>] [--access <access>]');
  }

  const options = {
    access: 'public',
    packageDir,
    tag: 'latest'
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];

    switch (arg) {
      case '--tag':
        if (!value) {
          throw new Error('missing value for --tag');
        }
        options.tag = value;
        index += 1;
        break;
      case '--access':
        if (!value) {
          throw new Error('missing value for --access');
        }
        options.access = value;
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const { packageDir, tag, access } = parseArgs(argv);
  publishPackageIfNeeded(packageDir, { tag, access });
}

export function isDirectExecution(argvEntry, moduleUrl = import.meta.url) {
  return Boolean(argvEntry) && path.resolve(argvEntry) === fileURLToPath(moduleUrl);
}

if (isDirectExecution(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
