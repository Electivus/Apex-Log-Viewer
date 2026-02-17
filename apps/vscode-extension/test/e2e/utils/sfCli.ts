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

function sfBin(): string {
  return process.platform === 'win32' ? 'sf.cmd' : 'sf';
}

export function getSfBinPath(): string {
  return sfBin();
}

export async function resolveSfBinAbsolutePath(): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'where sf'], { timeoutMs: 10_000 });
      const first = String(stdout || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)[0];
      return first || undefined;
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
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          // Avoid echoing stdout/stderr to prevent leaking auth tokens.
          const msg = `Command failed: ${file} ${args.join(' ')}`.trim();
          const err = new Error(msg) as Error & { code?: unknown };
          (err as any).code = (error as any).code;
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

export async function runSfJson(args: string[], options: ExecOptions = {}): Promise<any> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  const { stdout } = await execFileAsync(getSfBinPath(), withJson, options);
  const raw = String(stdout || '').trim();
  if (!raw) {
    throw new Error(`Empty JSON output from sf ${withJson.join(' ')}`.trim());
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
    throw new Error(`Invalid JSON output from sf ${withJson.join(' ')}`.trim());
  }
}
