import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type CliExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  timeoutMs?: number;
};

export type CliRunResult = {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutJson?: any;
  stderrJson?: any;
  errorMessage?: string;
  signal?: NodeJS.Signals | string;
};

function resolveBinaryName(): string {
  return process.platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

type ResolveAlvCliBinaryPathOptions = {
  repoRoot?: string;
  cargoBuildTarget?: string;
};

function resolveBinaryCandidates(options: ResolveAlvCliBinaryPathOptions = {}): string[] {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const binaryName = resolveBinaryName();
  const candidates = [path.join(repoRoot, 'target', 'debug', binaryName)];
  const cargoBuildTarget = String(options.cargoBuildTarget ?? process.env.CARGO_BUILD_TARGET ?? '').trim();

  if (cargoBuildTarget) {
    candidates.push(path.join(repoRoot, 'target', cargoBuildTarget, 'debug', binaryName));
  }

  return [...new Set(candidates)];
}

function tryParseCliJson(raw: string): any | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some command wrappers may add ANSI noise before the JSON payload.
  }

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

export function resolveAlvCliBinaryPath(options: ResolveAlvCliBinaryPathOptions = {}): string {
  const candidates = resolveBinaryCandidates(options);
  const binaryPath = candidates.find(candidate => existsSync(candidate));
  if (!binaryPath) {
    throw new Error(
      `Unable to locate apex-log-viewer standalone binary. Checked: ${candidates.join(', ')}`
    );
  }
  return binaryPath;
}

export async function runAlvCli(args: string[], options: CliExecOptions = {}): Promise<CliRunResult> {
  const command = resolveAlvCliBinaryPath({ repoRoot: options.repoRoot });
  const finalArgs = args.map(value => String(value ?? ''));

  return await new Promise(resolve => {
    execFile(
      command,
      finalArgs,
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env
        },
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        const stdoutText = String(stdout || '');
        const stderrText = String(stderr || '');
        const stdoutJson = tryParseCliJson(stdoutText);
        const stderrJson = tryParseCliJson(stderrText);

        if (!error) {
          resolve({
            command,
            args: finalArgs,
            exitCode: 0,
            stdout: stdoutText,
            stderr: stderrText,
            stdoutJson,
            stderrJson
          });
          return;
        }

        const execError = error as NodeJS.ErrnoException & { code?: unknown; signal?: NodeJS.Signals | string | null };
        resolve({
          command,
          args: finalArgs,
          exitCode: typeof execError.code === 'number' ? Number(execError.code) : -1,
          stdout: stdoutText,
          stderr: stderrText,
          stdoutJson,
          stderrJson,
          errorMessage: execError.message || String(error),
          signal: execError.signal || undefined
        });
      }
    );
  });
}
