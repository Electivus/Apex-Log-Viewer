import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type CliExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  timeoutMs?: number;
  allowWindowsCommandShim?: boolean;
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

function resolveBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

type ResolveAlvCliBinaryPathOptions = {
  repoRoot?: string;
  cargoBuildTarget?: string;
  platform?: NodeJS.Platform;
};

type ResolveAlvCliInvocationOptions = ResolveAlvCliBinaryPathOptions & {
  allowWindowsCommandShim?: boolean;
};

type CliInvocation = {
  command: string;
  args: string[];
};

function resolveBinaryCandidatesForName(binaryName: string, options: ResolveAlvCliBinaryPathOptions = {}): string[] {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  return [path.join(repoRoot, 'target', 'debug', binaryName)];
}

function resolveBinaryCandidates(options: ResolveAlvCliBinaryPathOptions = {}): string[] {
  return resolveBinaryCandidatesForName(resolveBinaryName(options.platform), options);
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

export function resolveAlvCliInvocation(options: ResolveAlvCliInvocationOptions = {}): CliInvocation {
  const binaryPath = resolveBinaryCandidates(options).find(candidate => existsSync(candidate));
  if (binaryPath) {
    return {
      command: binaryPath,
      args: []
    };
  }

  if (options.allowWindowsCommandShim && (options.platform ?? process.platform) === 'win32') {
    const shimPath = resolveBinaryCandidatesForName('apex-log-viewer.cmd', options).find(candidate => existsSync(candidate));
    if (shimPath) {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', shimPath]
      };
    }
  }

  throw new Error(
    `Unable to locate apex-log-viewer standalone binary. Checked: ${resolveBinaryCandidates(options).join(', ')}`
  );
}

export async function runAlvCli(args: string[], options: CliExecOptions = {}): Promise<CliRunResult> {
  const invocation = resolveAlvCliInvocation({
    repoRoot: options.repoRoot,
    allowWindowsCommandShim: options.allowWindowsCommandShim
  });
  const finalArgs = [...invocation.args, ...args.map(value => String(value ?? ''))];

  return await new Promise(resolve => {
    execFile(
      invocation.command,
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
            command: invocation.command,
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
          command: invocation.command,
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
