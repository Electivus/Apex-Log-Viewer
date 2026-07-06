import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, '.codex', 'skills', 'apex-log-viewer-cli');
const destination = path.join(repoRoot, 'packages', 'sf-plugin', 'skills', 'apex-log-viewer-cli');

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
