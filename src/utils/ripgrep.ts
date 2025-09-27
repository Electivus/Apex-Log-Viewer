import { spawn } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import { rgPath } from '@vscode/ripgrep';

let cachedBinary: string | null | undefined;

const RG_ARGS_BASE = [
  '--files-with-matches',
  '--no-messages',
  '--ignore-case',
  '--fixed-strings',
  '--glob',
  '*.log'
];

async function resolveRipgrepBinary(): Promise<string> {
  if (cachedBinary && cachedBinary !== 'rg') {
    return cachedBinary;
  }
  const candidates: string[] = [];
  if (cachedBinary === undefined) {
    candidates.push(rgPath);
    candidates.push('rg');
  } else if (cachedBinary !== null) {
    candidates.push(cachedBinary);
  }

  let lastError: Error | undefined;
  for (const candidate of candidates) {
    try {
      if (candidate !== 'rg') {
        await fs.access(candidate, fs.constants.X_OK);
      }
      const ok = await trySpawn(candidate, ['--version']);
      if (ok) {
        cachedBinary = candidate;
        return candidate;
      }
    } catch (error) {
      lastError = error as Error;
    }
  }
  cachedBinary = null;
  throw lastError ?? new Error('ripgrep binary is not available');
}

function trySpawn(binary: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

export async function ripgrepSearch(pattern: string, cwd: string): Promise<string[]> {
  let binary: string;
  try {
    binary = await resolveRipgrepBinary();
  } catch {
    return [];
  }

  const args = [...RG_ARGS_BASE, pattern, '.'];
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, { cwd });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        cachedBinary = null;
        resolve([]);
        return;
      }
      reject(err);
    });
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
