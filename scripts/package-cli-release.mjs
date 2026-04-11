import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CARGO_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin'
};

const TARGET_ORDER = Object.keys(CARGO_TARGETS);
export const RELEASE_TARGETS = [...TARGET_ORDER];

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function readCargoVersion(repoRoot) {
  const cargoToml = readText(path.join(repoRoot, 'crates', 'alv-cli', 'Cargo.toml'));
  const match = cargoToml.match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error('Unable to read crates/alv-cli version');
  }
  return match[1];
}

export function resolveBinaryName(target) {
  return target.startsWith('win32-') ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

export function resolveReleaseAssetName(version, target) {
  return target.startsWith('win32-')
    ? `apex-log-viewer-${version}-${target}.zip`
    : `apex-log-viewer-${version}-${target}.tar.gz`;
}

function compareTargets(left, right) {
  return TARGET_ORDER.indexOf(left) - TARGET_ORDER.indexOf(right);
}

function resolveReleaseBinaryCandidates(repoRoot, target) {
  const binaryName = resolveBinaryName(target);
  const cargoTarget = CARGO_TARGETS[target];
  const candidates = [path.join(repoRoot, 'apps', 'vscode-extension', 'bin', target, binaryName)];

  if (cargoTarget) {
    candidates.push(path.join(repoRoot, 'target', cargoTarget, 'release', binaryName));
  }
  candidates.push(path.join(repoRoot, 'target', 'release', binaryName));

  return candidates;
}

export function discoverReleaseBinaries(repoRoot, targets = TARGET_ORDER) {
  const binaries = {};
  for (const target of targets) {
    const candidates = resolveReleaseBinaryCandidates(repoRoot, target);
    const source = candidates.find(candidate => fs.existsSync(candidate));
    if (source) {
      binaries[target] = source;
    }
  }
  return binaries;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = createCrc32Table());
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function writeUInt16LE(buffer, value, offset) {
  buffer.writeUInt16LE(value & 0xffff, offset);
}

function writeUInt32LE(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function toDosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

function createStoredZipArchive(sourcePath, destinationPath, entryName = path.basename(sourcePath)) {
  const data = fs.readFileSync(sourcePath);
  const nameBuffer = Buffer.from(entryName, 'utf8');
  const { date, time } = toDosDateTime(fs.statSync(sourcePath).mtime);
  const crc = crc32(data);
  const localHeaderOffset = 0;

  const localHeader = Buffer.alloc(30 + nameBuffer.length);
  writeUInt32LE(localHeader, 0x04034b50, 0);
  writeUInt16LE(localHeader, 20, 4);
  writeUInt16LE(localHeader, 0, 6);
  writeUInt16LE(localHeader, 0, 8);
  writeUInt16LE(localHeader, time, 10);
  writeUInt16LE(localHeader, date, 12);
  writeUInt32LE(localHeader, crc, 14);
  writeUInt32LE(localHeader, data.length, 18);
  writeUInt32LE(localHeader, data.length, 22);
  writeUInt16LE(localHeader, nameBuffer.length, 26);
  writeUInt16LE(localHeader, 0, 28);
  nameBuffer.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBuffer.length);
  writeUInt32LE(centralHeader, 0x02014b50, 0);
  writeUInt16LE(centralHeader, 20, 4);
  writeUInt16LE(centralHeader, 20, 6);
  writeUInt16LE(centralHeader, 0, 8);
  writeUInt16LE(centralHeader, 0, 10);
  writeUInt16LE(centralHeader, time, 12);
  writeUInt16LE(centralHeader, date, 14);
  writeUInt32LE(centralHeader, crc, 16);
  writeUInt32LE(centralHeader, data.length, 20);
  writeUInt32LE(centralHeader, data.length, 24);
  writeUInt16LE(centralHeader, nameBuffer.length, 28);
  writeUInt16LE(centralHeader, 0, 30);
  writeUInt16LE(centralHeader, 0, 32);
  writeUInt16LE(centralHeader, 0, 34);
  writeUInt16LE(centralHeader, 0, 36);
  writeUInt32LE(centralHeader, fs.statSync(sourcePath).mode << 16, 38);
  writeUInt32LE(centralHeader, localHeaderOffset, 42);
  nameBuffer.copy(centralHeader, 46);

  const centralDirectoryOffset = localHeader.length + data.length;
  const endRecord = Buffer.alloc(22);
  writeUInt32LE(endRecord, 0x06054b50, 0);
  writeUInt16LE(endRecord, 0, 4);
  writeUInt16LE(endRecord, 0, 6);
  writeUInt16LE(endRecord, 1, 8);
  writeUInt16LE(endRecord, 1, 10);
  writeUInt32LE(endRecord, centralHeader.length, 12);
  writeUInt32LE(endRecord, centralDirectoryOffset, 16);
  writeUInt16LE(endRecord, 0, 20);

  ensureParentDir(destinationPath);
  fs.writeFileSync(destinationPath, Buffer.concat([localHeader, data, centralHeader, endRecord]));
}

function createTarGzArchive(sourcePath, destinationPath, entryName = path.basename(sourcePath)) {
  ensureParentDir(destinationPath);
  const result = spawnSync('tar', ['-czf', destinationPath, '-C', path.dirname(sourcePath), entryName], {
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(`tar -czf ${destinationPath} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

export function packageCliRelease({
  version,
  outDir,
  binaries,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  requiredTargets
}) {
  const releaseVersion = version ?? readCargoVersion(repoRoot);
  const releaseOutDir = outDir ?? path.join(repoRoot, 'dist', 'release');
  const requestedBinaries = binaries && Object.keys(binaries).length > 0 ? binaries : discoverReleaseBinaries(repoRoot);
  const expectedTargets = (requiredTargets ??
    (binaries && Object.keys(binaries).length > 0 ? Object.keys(binaries) : RELEASE_TARGETS)).slice();
  const missingTargets = expectedTargets.filter(target => !requestedBinaries[target]);

  if (missingTargets.length > 0) {
    throw new Error(
      `packageCliRelease is missing built binaries for targets: ${missingTargets.join(', ')}`
    );
  }

  const targets = expectedTargets.sort(compareTargets);

  if (targets.length === 0) {
    throw new Error('packageCliRelease requires at least one built binary');
  }

  fs.rmSync(releaseOutDir, { recursive: true, force: true });
  fs.mkdirSync(releaseOutDir, { recursive: true });

  const assets = [];
  const checksumLines = [];

  for (const target of targets) {
    const binaryPath = requestedBinaries[target];
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary for target ${target} does not exist: ${binaryPath}`);
    }

    const assetPath = path.join(releaseOutDir, resolveReleaseAssetName(releaseVersion, target));
    if (target.startsWith('win32-')) {
      createStoredZipArchive(binaryPath, assetPath);
    } else {
      createTarGzArchive(binaryPath, assetPath);
    }

    assets.push(assetPath);
    checksumLines.push(`${sha256File(assetPath)}  ${path.basename(assetPath)}`);
  }

  const checksumsFile = path.join(releaseOutDir, `apex-log-viewer-${releaseVersion}-SHA256SUMS.txt`);
  writeText(checksumsFile, `${checksumLines.join('\n')}\n`);

  return {
    assets,
    checksumsFile,
    outDir: releaseOutDir,
    version: releaseVersion
  };
}

function parseCliArgs(argv) {
  const targets = [];
  let version;
  let outDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'release');

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      version = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out-dir') {
      outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    targets.push(arg);
  }

  return { targets, version, outDir };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, '..');

if (process.argv[1] === __filename) {
  const { targets, version, outDir } = parseCliArgs(process.argv.slice(2));
  const binaries = targets.length > 0 ? discoverReleaseBinaries(defaultRepoRoot, targets) : discoverReleaseBinaries(defaultRepoRoot);
  const result = packageCliRelease({
    version,
    outDir,
    binaries,
    repoRoot: defaultRepoRoot,
    requiredTargets: targets.length > 0 ? targets : RELEASE_TARGETS
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
