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
  env?: NodeJS.ProcessEnv;
};

type ResolveAlvCliInvocationOptions = ResolveAlvCliBinaryPathOptions & {
  allowWindowsCommandShim?: boolean;
};

type ResolveElectivusPluginInvocationOptions = {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
};

type CliInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

function resolveBinaryCandidatesForName(binaryName: string, options: ResolveAlvCliBinaryPathOptions = {}): string[] {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  return [path.join(repoRoot, 'target', 'debug', binaryName)];
}

function resolveBinaryCandidates(options: ResolveAlvCliBinaryPathOptions = {}): string[] {
  return resolveBinaryCandidatesForName(resolveBinaryName(options.platform), options);
}

function resolveCliEnvironment(options: ResolveAlvCliBinaryPathOptions = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env
  };
}

function isWindowsCommandShim(value: string, platform = process.platform): boolean {
  return platform === 'win32' && value.toLowerCase().endsWith('.cmd');
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function windowsCommandShimInvocation(shimPath: string): CliInvocation {
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/c', 'call', quoteWindowsCommandArgument(shimPath)],
    windowsVerbatimArguments: true
  };
}

function resolveConfiguredCliBinaryPath(options: ResolveAlvCliBinaryPathOptions = {}): string | undefined {
  const rawPath = String(resolveCliEnvironment(options).ALV_CLI_BINARY_PATH ?? '').trim();
  if (!rawPath) {
    return undefined;
  }

  const repoRoot = options.repoRoot || resolveRepoRoot();
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
}

function formatMissingBinaryMessage(configuredBinaryPath: string | undefined, fallbackCandidates: string[]): string {
  if (configuredBinaryPath) {
    return `Unable to locate apex-log-viewer standalone binary from ALV_CLI_BINARY_PATH. Checked: ${[
      configuredBinaryPath,
      ...fallbackCandidates
    ].join(', ')}`;
  }

  return `Unable to locate apex-log-viewer standalone binary. Checked: ${fallbackCandidates.join(', ')}`;
}

function resolveDefaultPluginBinPath(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'sf-plugin', 'bin', 'run.js');
}

function resolveConfiguredPluginBinPath(options: ResolveElectivusPluginInvocationOptions = {}): string {
  const env = resolveCliEnvironment({ env: options.env });
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const rawPath = String(env.ALV_ELECTIVUS_PLUGIN_BIN_PATH ?? '').trim();
  return rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath)) : resolveDefaultPluginBinPath(repoRoot);
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
  const configuredBinaryPath = resolveConfiguredCliBinaryPath(options);
  const candidates = resolveBinaryCandidates(options);

  if (configuredBinaryPath) {
    if (existsSync(configuredBinaryPath)) {
      return configuredBinaryPath;
    }
    throw new Error(formatMissingBinaryMessage(configuredBinaryPath, candidates));
  }

  const binaryPath = candidates.find(candidate => existsSync(candidate));
  if (!binaryPath) {
    throw new Error(formatMissingBinaryMessage(undefined, candidates));
  }
  return binaryPath;
}

export function resolveAlvCliInvocation(options: ResolveAlvCliInvocationOptions = {}): CliInvocation {
  const configuredBinaryPath = resolveConfiguredCliBinaryPath(options);
  const candidates = resolveBinaryCandidates(options);

  if (configuredBinaryPath) {
    if (existsSync(configuredBinaryPath)) {
      return isWindowsCommandShim(configuredBinaryPath, options.platform)
        ? windowsCommandShimInvocation(configuredBinaryPath)
        : {
            command: configuredBinaryPath,
            args: []
          };
    }
    throw new Error(formatMissingBinaryMessage(configuredBinaryPath, candidates));
  }

  const binaryPath = candidates.find(candidate => existsSync(candidate));
  if (binaryPath) {
    return {
      command: binaryPath,
      args: []
    };
  }

  if (options.allowWindowsCommandShim && (options.platform ?? process.platform) === 'win32') {
    const shimPath = resolveBinaryCandidatesForName('apex-log-viewer.cmd', options).find(candidate =>
      existsSync(candidate)
    );
    if (shimPath) {
      return windowsCommandShimInvocation(shimPath);
    }
  }

  throw new Error(formatMissingBinaryMessage(undefined, resolveBinaryCandidates(options)));
}

export function resolveElectivusPluginInvocation(options: ResolveElectivusPluginInvocationOptions = {}): CliInvocation {
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
  const commandArgs = args.map(value => String(value ?? ''));
  const finalArgs = invocation.windowsVerbatimArguments
    ? [...invocation.args, ...commandArgs.map(quoteWindowsCommandArgument)]
    : [...invocation.args, ...commandArgs];

  return await new Promise(resolve => {
    execFile(
      invocation.command,
      finalArgs,
      {
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024 * 20,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments
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
