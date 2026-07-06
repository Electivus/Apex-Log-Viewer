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

type ResolveElectivusPluginInvocationOptions = {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
};

type CliInvocation = {
  command: string;
  args: string[];
};

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function resolveCliEnvironment(options: { env?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env
  };
}

function resolveDefaultPluginBinPath(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js');
}

function resolveConfiguredPluginBinPath(options: ResolveElectivusPluginInvocationOptions = {}): string {
  const env = resolveCliEnvironment({ env: options.env });
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const rawPath = String(env.ALV_ELECTIVUS_PLUGIN_BIN_PATH ?? '').trim();
  return rawPath
    ? path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(repoRoot, rawPath)
    : resolveDefaultPluginBinPath(repoRoot);
}

function formatMissingPluginMessage(pluginBinPath: string): string {
  return `Unable to locate local sf electivus plugin bin. Checked: ${pluginBinPath}. Run npm run build:sf-plugin before CLI E2E, or set ALV_ELECTIVUS_PLUGIN_BIN_PATH.`;
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
  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const start =
    firstObject === -1 ? firstArray : firstArray === -1 ? firstObject : Math.min(firstObject, firstArray);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function resolveElectivusPluginInvocation(
  options: ResolveElectivusPluginInvocationOptions = {}
): CliInvocation {
  const pluginBinPath = resolveConfiguredPluginBinPath(options);
  if (!existsSync(pluginBinPath)) {
    throw new Error(formatMissingPluginMessage(pluginBinPath));
  }

  return {
    command: process.execPath,
    args: [pluginBinPath, 'electivus']
  };
}

export async function runAlvCli(args: string[], options: CliExecOptions = {}): Promise<CliRunResult> {
  const env = resolveCliEnvironment({ env: options.env });
  const invocation = resolveElectivusPluginInvocation({
    repoRoot: options.repoRoot,
    env
  });
  const finalArgs = [...invocation.args, ...args.map(value => String(value ?? ''))];

  return await new Promise(resolve => {
    execFile(
      invocation.command,
      finalArgs,
      {
        cwd: options.cwd,
        env,
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
