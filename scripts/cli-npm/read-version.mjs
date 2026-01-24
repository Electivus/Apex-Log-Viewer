import fs from 'fs';

export function readCargoVersion(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('version not found');
  }
  return match[1];
}
