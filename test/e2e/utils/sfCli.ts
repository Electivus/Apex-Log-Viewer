import path from 'node:path';
import { execFile } from 'node:child_process';

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
};

function tryParseSfJson(raw: string): any | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  // Some CLI/plugin combinations may print non-JSON noise before/after JSON.
  const cleaned = trimmed.replace(/\u001b\[[0-9;]*m/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatSfErrorDetails(stdout: string, stderr: string): string | undefined {
  for (const raw of [stdout, stderr]) {
    const parsed = tryParseSfJson(raw);
    if (!parsed) {
      continue;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    const message = typeof parsed.message === 'string' ? parsed.message : undefined;
    if (message) {
      return name ? `${name}: ${message}` : message;
    }
  }
  return undefined;
}

function sfBin(): string {
  return process.platform === 'win32' ? 'sf.cmd' : 'sf';
}

export function getSfBinPath(): string {
  return sfBin();
}

let resolvedSfBinAbsolutePathPromise: Promise<string | undefined> | undefined;

export function __resetResolvedSfBinAbsolutePathCacheForTests(): void {
  resolvedSfBinAbsolutePathPromise = undefined;
}

export async function resolveSfBinAbsolutePath(): Promise<string | undefined> {
  if (!resolvedSfBinAbsolutePathPromise) {
    resolvedSfBinAbsolutePathPromise = (async () => {
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'where sf'], { timeoutMs: 10_000 });
          const candidates = String(stdout || '')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean);
          const preferred = candidates.find(value => /\.cmd$/i.test(value));
          return preferred || candidates[0] || undefined;
        }
        const { stdout } = await execFileAsync('bash', ['-lc', 'command -v sf'], { timeoutMs: 10_000 });
        const resolved = String(stdout || '').trim();
        return resolved || undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return await resolvedSfBinAbsolutePathPromise;
}

export async function resolveSfCliInvocation(): Promise<{ sfBinPath: string; nodeBinPath: string } | undefined> {
  const sfBinPath = await resolveSfBinAbsolutePath();
  if (!sfBinPath) {
    return undefined;
  }
  // Prefer the Node binary used to run the E2E tests. This is usually more reliable
  // than assuming `node` is available on PATH inside the VS Code extension host.
  const nodeBinPath = process.execPath;
  return { sfBinPath, nodeBinPath };
}

function execProcessFileAsync(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const callback = (error: unknown, stdout: string, stderr: string) => {
      if (error) {
        const details = formatSfErrorDetails(String(stdout || ''), String(stderr || ''));
        // Avoid echoing stdout/stderr directly to prevent leaking auth tokens.
        const msg = details
          ? `Command failed: ${file} ${args.join(' ')}\n${details}`.trim()
          : `Command failed: ${file} ${args.join(' ')}`.trim();
        const err = new Error(msg) as Error & { code?: unknown };
        (err as any).code = (error as any).code;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    };

    const execOptions = {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8' as BufferEncoding,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024 * 20
    };

    execFile(file, args, execOptions, callback);
  });
}

function normalizeExecArgs(args: string[]): string[] {
  return args.map(arg => {
    const value = String(arg ?? '');
    if (value.includes('\0')) {
      throw new Error('Command arguments cannot contain null bytes.');
    }
    return value;
  });
}

function getTrustedSfExecutable(file: string): string {
  const normalized = String(file || '').trim();
  const basename = path.basename(normalized).toLowerCase();
  if (basename === 'sf' || basename === 'sf.cmd' || basename === 'sf.exe') {
    return normalized;
  }
  throw new Error(`Refusing to execute unexpected Salesforce CLI binary '${file}'.`);
}

async function execSfCliAsync(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const executable = getTrustedSfExecutable(file);
  const finalArgs = normalizeExecArgs(args);

  if (process.platform === 'win32' && /\.cmd$/i.test(executable)) {
    return await execProcessFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...finalArgs], options);
  }

  return await execProcessFileAsync(executable, finalArgs, options);
}

export async function runSfJson(args: string[], options: ExecOptions = {}): Promise<any> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  const sfPath = (await resolveSfBinAbsolutePath()) || getSfBinPath();
  const { stdout } = await execSfCliAsync(sfPath, withJson, options);
  const raw = String(stdout || '').trim();
  if (!raw) {
    throw new Error(`Empty JSON output from ${sfPath} ${withJson.join(' ')}`.trim());
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Some CLI/plugin combinations may print non-JSON noise before/after JSON.
    const cleaned = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error(`Invalid JSON output from ${sfPath} ${withJson.join(' ')}`.trim());
  }
}
