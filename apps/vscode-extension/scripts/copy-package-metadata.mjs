import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_METADATA_FILES = ['README.md', 'CHANGELOG.md', 'LICENSE', 'telemetry.json'];

export function copyPackageMetadata({ repoRoot }) {
  const appRoot = path.join(repoRoot, 'apps', 'vscode-extension');

  for (const relativePath of PACKAGE_METADATA_FILES) {
    const source = path.join(repoRoot, relativePath);
    const destination = path.join(appRoot, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`package metadata asset not found at ${source}`);
    }
    fs.copyFileSync(source, destination);
  }

  return {
    files: PACKAGE_METADATA_FILES.map(relativePath => path.join(appRoot, relativePath))
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyPackageMetadata({ repoRoot });
}
