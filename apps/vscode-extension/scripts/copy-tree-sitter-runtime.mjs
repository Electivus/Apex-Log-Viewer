import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TREE_SITTER_RUNTIME_FILES = [
  'README.md',
  'LICENSE',
  'bindings/node/sflog-triage.js',
  'bindings/node/sflog-triage.d.ts',
  'sflog/triage.js'
];

export function copyTreeSitterRuntime({ repoRoot }) {
  const sourceRoot = path.join(repoRoot, 'node_modules', 'tree-sitter-sfapex');
  const destinationRoot = path.join(
    repoRoot,
    'apps',
    'vscode-extension',
    'node_modules',
    'tree-sitter-sfapex'
  );

  for (const relativePath of TREE_SITTER_RUNTIME_FILES) {
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(destinationRoot, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`tree-sitter runtime asset not found at ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return {
    destinationRoot,
    files: TREE_SITTER_RUNTIME_FILES.map(relativePath => path.join(destinationRoot, relativePath))
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyTreeSitterRuntime({ repoRoot });
}
