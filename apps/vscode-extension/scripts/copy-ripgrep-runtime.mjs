import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyRipgrepRuntime({ repoRoot }) {
  const sourceRoot = path.join(repoRoot, 'node_modules', '@vscode', 'ripgrep');
  const destinationRoot = path.join(
    repoRoot,
    'apps',
    'vscode-extension',
    'node_modules',
    '@vscode',
    'ripgrep'
  );

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`ripgrep runtime package not found at ${sourceRoot}`);
  }

  fs.rmSync(destinationRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  fs.cpSync(sourceRoot, destinationRoot, { recursive: true });

  return { destinationRoot };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyRipgrepRuntime({ repoRoot });
}
