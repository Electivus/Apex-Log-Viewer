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

function quoteWindowsCmdArg(value: string): string {
  const raw = String(value ?? '');
  return `"${raw.replace(/"/g, '""')}"`;
}

export async function resolveSfBinAbsolutePath(): Promise<string | undefined> {
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

export function execFileAsync(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
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

    if (process.platform === 'win32' && /\.cmd$/i.test(file)) {
      const command = [file, ...args].map(quoteWindowsCmdArg).join(' ');
      execFile('cmd.exe', ['/d', '/s', '/c', command], execOptions, callback);
      return;
    }

    execFile(file, args, execOptions, callback);
  });
}

export async function runSfJson(args: string[], options: ExecOptions = {}): Promise<any> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  const sfPath = (await resolveSfBinAbsolutePath()) || getSfBinPath();
  const { stdout } = await execFileAsync(sfPath, withJson, options);
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
