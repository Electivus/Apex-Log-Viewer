import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGE_DIR = 'packages/sf-plugin';
const DEFAULT_OUT_DIR = 'dist/sf-plugin-npm';

function resolveFromRepo(repoRoot, value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function normalizePackageFileEntry(entry) {
  const normalized = String(entry || '').replace(/^\/+/, '');
  if (!normalized || normalized.split(/[\\/]+/).includes('..')) {
    throw new Error(`invalid package files entry: ${entry}`);
  }
  return normalized;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function stageSfPluginPackage({
  repoRoot = process.cwd(),
  packageDir = DEFAULT_PACKAGE_DIR,
  outDir = DEFAULT_OUT_DIR
} = {}) {
  const sourceDir = resolveFromRepo(repoRoot, packageDir);
  const targetDir = resolveFromRepo(repoRoot, outDir);
  const sourceManifestPath = path.join(sourceDir, 'package.json');
  const manifest = await readJson(sourceManifestPath);
  const files = Array.isArray(manifest.files) ? manifest.files.map(normalizePackageFileEntry) : [];

  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    throw new Error('staging output directory must be different from the source package directory');
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const stagedManifest = { ...manifest };
  delete stagedManifest.private;
  await fs.writeFile(path.join(targetDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8');

  for (const file of files) {
    const source = path.join(sourceDir, file);
    const target = path.join(targetDir, file);
    try {
      await fs.access(source);
    } catch {
      throw new Error(`missing plugin package artifact ${source}; run npm run build:sf-plugin first`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true });
  }

  return {
    packageDir: sourceDir,
    outDir: targetDir,
    files
  };
}

function parseArgs(argv) {
  const options = {
    packageDir: DEFAULT_PACKAGE_DIR,
    outDir: DEFAULT_OUT_DIR
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--package-dir':
        if (!value) throw new Error('missing value for --package-dir');
        options.packageDir = value;
        index += 1;
        break;
      case '--out':
        if (!value) throw new Error('missing value for --out');
        options.outDir = value;
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await stageSfPluginPackage(parseArgs(argv));
  console.log(`Staged ${path.join(result.outDir, 'package.json')}`);
}

export function isDirectExecution(argvEntry, moduleUrl = import.meta.url) {
  return Boolean(argvEntry) && path.resolve(argvEntry) === fileURLToPath(moduleUrl);
}

if (isDirectExecution(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
