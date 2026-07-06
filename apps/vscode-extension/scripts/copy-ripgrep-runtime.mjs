import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyRipgrepRuntime({ repoRoot }) {
  const sourceNamespaceRoot = path.join(repoRoot, 'node_modules', '@vscode');
  const destinationNamespaceRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'node_modules', '@vscode');

  if (!fs.existsSync(sourceNamespaceRoot)) {
    throw new Error(`@vscode package namespace not found at ${sourceNamespaceRoot}`);
  }

  const packages = fs
    .readdirSync(sourceNamespaceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^ripgrep(?:-|$)/.test(entry.name))
    .map(entry => entry.name)
    .sort();

  if (!packages.includes('ripgrep')) {
    throw new Error(`ripgrep runtime package not found under ${sourceNamespaceRoot}`);
  }

  fs.mkdirSync(destinationNamespaceRoot, { recursive: true });
  for (const packageName of packages) {
    const sourceRoot = path.join(sourceNamespaceRoot, packageName);
    const destinationRoot = path.join(destinationNamespaceRoot, packageName);
    fs.rmSync(destinationRoot, { recursive: true, force: true });
    fs.cpSync(sourceRoot, destinationRoot, { recursive: true });
  }

  return { destinationNamespaceRoot, packages };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyRipgrepRuntime({ repoRoot });
}
