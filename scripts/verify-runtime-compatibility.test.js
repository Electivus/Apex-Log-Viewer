const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, 'verify-runtime-compatibility.mjs');

test('verifyLinuxX64Binary accepts a static binary without an interpreter, shared-library deps, or GLIBC version needs', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-runtime-compat-binary-'));
  const binaryPath = path.join(repoRoot, 'apex-log-viewer');
  const calls = [];

  try {
    fs.writeFileSync(binaryPath, 'binary');

    const result = mod.verifyLinuxX64Binary({
      binaryPath,
      spawnSyncImpl(command, args) {
        calls.push([command, ...args]);
        if (args[0] === '-lW') {
          return { status: 0, stdout: 'Program Headers:\n  LOAD\n', stderr: '' };
        }
        if (args[0] === '-dW') {
          return { status: 0, stdout: '\nThere is no dynamic section in this file.\n', stderr: '' };
        }
        if (args[0] === '--version-info') {
          return { status: 0, stdout: 'No version information found in this file.\n', stderr: '' };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      }
    });

    assert.deepEqual(calls, [
      ['readelf', '-lW', binaryPath],
      ['readelf', '-dW', binaryPath],
      ['readelf', '--version-info', binaryPath]
    ]);
    assert.deepEqual(result.checks, [
      'no-elf-interpreter',
      'no-needed-libraries',
      'no-glibc-version-needs'
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('verifyLinuxX64Binary rejects dynamically linked runtimes with an ELF interpreter', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-runtime-compat-binary-'));
  const binaryPath = path.join(repoRoot, 'apex-log-viewer');

  try {
    fs.writeFileSync(binaryPath, 'binary');

    assert.throws(
      () =>
        mod.verifyLinuxX64Binary({
          binaryPath,
          spawnSyncImpl(command, args) {
            if (args[0] === '-lW') {
              return {
                status: 0,
                stdout: 'Program Headers:\n  INTERP         0x0000000000000318\n',
                stderr: ''
              };
            }
            throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
          }
        }),
      /must not declare an ELF interpreter/i
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('verifyRuntimeCompatibility extracts the linux-x64 archive and validates the packaged binary', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-runtime-compat-archive-'));
  const archivePath = path.join(repoRoot, 'apex-log-viewer-1.2.3-linux-x64.tar.gz');
  const extractedDir = path.join(repoRoot, 'tmp-extract');
  const calls = [];
  const cleanupCalls = [];

  try {
    fs.writeFileSync(archivePath, 'archive');

    const result = mod.verifyRuntimeCompatibility({
      target: 'linux-x64',
      archivePath,
      mkdtempSyncImpl() {
        fs.mkdirSync(extractedDir, { recursive: true });
        return extractedDir;
      },
      rmSyncImpl(dir, options) {
        cleanupCalls.push({ dir, options });
      },
      spawnSyncImpl(command, args) {
        calls.push([command, ...args]);
        if (command === 'tar') {
          fs.writeFileSync(path.join(extractedDir, 'apex-log-viewer'), 'binary');
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'readelf' && args[0] === '-lW') {
          return { status: 0, stdout: 'Program Headers:\n  LOAD\n', stderr: '' };
        }
        if (command === 'readelf' && args[0] === '-dW') {
          return { status: 0, stdout: 'There is no dynamic section in this file.\n', stderr: '' };
        }
        if (command === 'readelf' && args[0] === '--version-info') {
          return { status: 0, stdout: 'No version information found in this file.\n', stderr: '' };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      }
    });

    assert.deepEqual(calls, [
      ['tar', '-xzf', archivePath, '-C', extractedDir],
      ['readelf', '-lW', path.join(extractedDir, 'apex-log-viewer')],
      ['readelf', '-dW', path.join(extractedDir, 'apex-log-viewer')],
      ['readelf', '--version-info', path.join(extractedDir, 'apex-log-viewer')]
    ]);
    assert.deepEqual(cleanupCalls, [
      {
        dir: extractedDir,
        options: { recursive: true, force: true }
      }
    ]);
    assert.equal(result.binaryPath, path.join(extractedDir, 'apex-log-viewer'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
