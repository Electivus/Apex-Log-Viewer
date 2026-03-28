import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCurrentTarget() {
  return `${process.platform}-${process.arch}`;
}

function resolveBinaryName(target) {
  return target.startsWith('win32-') ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

function resolveArguments(argv) {
  let target = resolveCurrentTarget();
  let profile = 'debug';

  if (argv[0]) {
    if (argv[0] === 'debug' || argv[0] === 'release') {
      profile = argv[0];
    } else {
      target = argv[0];
    }
  }

  if (argv[1]) {
    profile = argv[1];
  }

  return { target, profile };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const { target, profile } = resolveArguments(process.argv.slice(2));
const binaryName = resolveBinaryName(target);
const source = path.join(repoRoot, 'target', profile, binaryName);
const destinationDir = path.join(repoRoot, 'apps', 'vscode-extension', 'bin', target);
const destination = path.join(destinationDir, binaryName);

if (!fs.existsSync(source)) {
  throw new Error(`Runtime binary not found at ${source}. Build the Rust CLI before copying it.`);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
