import { spawn } from 'child_process';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';

export async function ripgrepSearch(pattern: string, cwd: string): Promise<string[]> {
  const args = [
    '--files-with-matches',
    '--no-messages',
    '--ignore-case',
    '--fixed-strings',
    '--glob',
    '*.log',
    pattern,
    '.'
  ];
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(rgPath, args, { cwd });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || code === 1) {
        const files = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .map(p => path.resolve(cwd, p));
        resolve(files);
      } else {
        reject(new Error(stderr || `ripgrep exited with code ${code}`));
      }
    });
  });
}
