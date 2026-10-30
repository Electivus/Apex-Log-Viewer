import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_METADATA_FILES = [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'telemetry.json'
];

/** Files the extension packages from elsewhere in the repository, as repo-relative source and app-relative destination. */
export const PACKAGE_SCHEMA_FILES = [
  {
    source: 'packages/core/schemas/sfdx-project.electivus.schema.json',
    destination: 'schemas/sfdx-project.electivus.schema.json'
  }
];

export function copyPackageMetadata({ repoRoot }) {
  const appRoot = path.join(repoRoot, 'apps', 'vscode-extension');
  const copies = [
    ...PACKAGE_METADATA_FILES.map(relativePath => ({ source: relativePath, destination: relativePath })),
    ...PACKAGE_SCHEMA_FILES
  ];

  for (const copy of copies) {
    const source = path.join(repoRoot, copy.source);
    const destination = path.join(appRoot, copy.destination);
    if (!fs.existsSync(source)) {
      throw new Error(`package metadata asset not found at ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  return {
    files: copies.map(copy => path.join(appRoot, copy.destination))
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

if (process.argv[1] === __filename) {
  copyPackageMetadata({ repoRoot });
}
