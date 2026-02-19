import { spawn } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import { rgPath } from '@vscode/ripgrep';

let cachedBinary: string | null | undefined;

const RG_ARGS_BASE = ['--no-messages', '--ignore-case', '--fixed-strings', '--glob', '*.log'];

export type RipgrepMatch = {
  filePath: string;
  lineText: string;
  submatches: Array<{ start: number; end: number }>;
};

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

export async function ripgrepSearch(
  pattern: string,
  cwd: string,
  signal?: AbortSignal
): Promise<RipgrepMatch[]> {
  let binary: string;
  try {
    binary = await resolveRipgrepBinary();
  } catch {
    return [];
  }

  const args = [...RG_ARGS_BASE, '--json', '--max-count', '1', '--', pattern, '.'];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve([]);
      return;
    }
    const matches: RipgrepMatch[] = [];
    let stderr = '';
    let buffer = '';
    const child = spawn(binary, args, { cwd });
    let settled = false;
    let abortHandler: (() => void) | undefined;
    const removeAbortListener = () => {
      if (abortHandler) {
        signal?.removeEventListener('abort', abortHandler);
      }
    };
    const finishResolve = (value: RipgrepMatch[]) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      reject(error);
    };
    abortHandler = () => {
      if (settled) {
        return;
      }
      child.kill();
      settled = true;
      removeAbortListener();
      resolve([]);
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    const flushBuffer = () => {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processJsonLine(line, matches, cwd);
        newlineIndex = buffer.indexOf('\n');
      }
    };
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      flushBuffer();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        cachedBinary = null;
        finishResolve([]);
        return;
      }
      finishReject(err as Error);
    });
    child.on('close', code => {
      flushBuffer();
      if (buffer.trim().length > 0) {
        processJsonLine(buffer, matches, cwd);
        buffer = '';
      }
      if (code === 0 || code === 1) {
        finishResolve(matches);
      } else {
        finishReject(new Error(stderr || `ripgrep exited with code ${code}`));
      }
    });
  });
}

function processJsonLine(line: string, matches: RipgrepMatch[], cwd: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const event = JSON.parse(trimmed);
    if (event?.type !== 'match') {
      return;
    }
    const pathText: unknown = event?.data?.path?.text;
    const lineText: unknown = event?.data?.lines?.text;
    const submatchesRaw: unknown = event?.data?.submatches;
    if (typeof pathText !== 'string' || typeof lineText !== 'string' || !Array.isArray(submatchesRaw)) {
      return;
    }
    const submatches = submatchesRaw
      .map((sm: any) => ({ start: Number(sm?.start) ?? 0, end: Number(sm?.end) ?? 0 }))
      .filter(sm => Number.isFinite(sm.start) && Number.isFinite(sm.end) && sm.end > sm.start);
    matches.push({
      filePath: path.resolve(cwd, pathText),
      lineText,
      submatches
    });
  } catch (error) {
    console.warn('ripgrep: failed to parse json line', error);
  }
}
