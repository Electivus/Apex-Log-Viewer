import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const PACKAGE_BY_TARGET = {
  'linux-x64': '@electivus/apex-log-viewer-linux-x64',
  'linux-arm64': '@electivus/apex-log-viewer-linux-arm64',
  'darwin-x64': '@electivus/apex-log-viewer-darwin-x64',
  'darwin-arm64': '@electivus/apex-log-viewer-darwin-arm64',
  'win32-x64': '@electivus/apex-log-viewer-win32-x64',
  'win32-arm64': '@electivus/apex-log-viewer-win32-arm64'
} as const;

export const APP_SERVER_UNSUPPORTED_MESSAGE =
  'app-server is a runtime-only command and is not exposed through sf electivus. Use the native apex-log-viewer binary path for app-server --stdio.';

type PackageTarget = keyof typeof PACKAGE_BY_TARGET;
type WritableTarget = {
  write(chunk: string): unknown;
};

export type RuntimeExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
};

export type ResolveRuntimeBinaryPathOptions = {
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  existsSync?: (filePath: string) => boolean;
  requireResolve?: (id: string) => string;
};

export type RunRuntimeProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
};

export type ExecuteRustBackedCommandOptions = {
  argv: readonly string[];
  jsonEnabled: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: WritableTarget;
  stderr?: WritableTarget;
  resolveBinaryPath?: (options: ResolveRuntimeBinaryPathOptions) => string;
  runRuntime?: (
    binaryPath: string,
    args: readonly string[],
    options: RunRuntimeProcessOptions
  ) => Promise<RuntimeExecutionResult>;
};

export class RuntimeExitError extends Error {
  public readonly exitCode: number;

  public constructor(exitCode: number) {
    super(`Electivus Rust runtime exited with code ${exitCode}.`);
    this.name = 'RuntimeExitError';
    this.exitCode = exitCode;
  }
}

export function resolvePackageForTarget(platform: string = process.platform, arch: string = process.arch): string {
  const target = `${platform}-${arch}` as PackageTarget;
  const packageName = PACKAGE_BY_TARGET[target];
  if (!packageName) {
    throw new Error(`Unsupported platform/arch target: ${target}`);
  }
  return packageName;
}

export function resolveRuntimeBinaryPath(options: ResolveRuntimeBinaryPathOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const existsSync = options.existsSync ?? nodeExistsSync;
  const requireResolve = options.requireResolve ?? ((id: string) => require.resolve(id));
  const configuredBinaryPath = String(env.ALV_CLI_BINARY_PATH ?? '').trim();

  if (configuredBinaryPath) {
    const resolvedPath = path.isAbsolute(configuredBinaryPath)
      ? configuredBinaryPath
      : path.resolve(cwd, configuredBinaryPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(
        `Unable to locate Electivus Rust runtime from ALV_CLI_BINARY_PATH. Checked: ${resolvedPath}`
      );
    }
    return resolvedPath;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageName = resolvePackageForTarget(platform, arch);
  const packageJsonPath = resolveNativePackageJson(packageName, requireResolve);
  const binaryPath = path.join(path.dirname(packageJsonPath), 'bin', binaryNameForPlatform(platform));

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Unable to locate Electivus Rust runtime in ${packageName}. Checked: ${binaryPath}`
    );
  }

  return binaryPath;
}

export function normalizeRuntimeArgs(
  argv: readonly string[],
  options: { jsonEnabled: boolean }
): string[] {
  const normalizedArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');

    if (isJsonFlag(arg)) {
      continue;
    }

    if (arg === '--flags-dir') {
      index += 1;
      continue;
    }

    if (arg.startsWith('--flags-dir=')) {
      continue;
    }

    normalizedArgs.push(arg);
  }

  if (normalizedArgs[0] === 'app-server') {
    throw new Error(APP_SERVER_UNSUPPORTED_MESSAGE);
  }

  if (options.jsonEnabled) {
    normalizedArgs.push('--json');
  }

  return normalizedArgs;
}

export function parseRuntimeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Electivus Rust runtime did not produce JSON output.');
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Keep going: some wrappers can add ANSI warnings before the payload.
  }

  const cleaned = stripAnsi(trimmed);
  const candidate = extractJsonCandidate(cleaned);
  if (candidate) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Fall through to the diagnostic below.
    }
  }

  throw new Error(`Electivus Rust runtime produced invalid JSON output: ${preview(trimmed)}`);
}

export async function runRuntimeProcess(
  binaryPath: string,
  args: readonly string[],
  options: RunRuntimeProcessOptions = {}
): Promise<RuntimeExecutionResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true
  };

  return await new Promise((resolve, reject) => {
    const child = spawnImpl(binaryPath, [...args], spawnOptions);
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout,
        stderr
      });
    });
  });
}

export async function executeRustBackedCommand(
  options: ExecuteRustBackedCommandOptions
): Promise<unknown> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const resolveBinaryPath = options.resolveBinaryPath ?? resolveRuntimeBinaryPath;
  const runRuntime = options.runRuntime ?? runRuntimeProcess;
  const runtimeArgs = normalizeRuntimeArgs(options.argv, { jsonEnabled: options.jsonEnabled });
  const binaryPath = resolveBinaryPath({ env, cwd });
  const result = await runRuntime(binaryPath, runtimeArgs, { cwd, env });
  const exitCode = resolveRuntimeExitCode(result);

  if (exitCode !== 0) {
    if (!options.jsonEnabled && result.stdout) {
      stdout.write(result.stdout);
    }
    if (result.stderr) {
      stderr.write(result.stderr);
    }
    throw new RuntimeExitError(exitCode);
  }

  if (options.jsonEnabled) {
    if (result.stderr) {
      stderr.write(result.stderr);
    }
    return parseRuntimeJson(result.stdout);
  }

  if (result.stdout) {
    stdout.write(result.stdout);
  }
  if (result.stderr) {
    stderr.write(result.stderr);
  }
  return undefined;
}

function resolveNativePackageJson(
  packageName: string,
  requireResolve: (id: string) => string
): string {
  try {
    return requireResolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `Unable to resolve ${packageName}. Reinstall @electivus/plugin-electivus with optional dependencies enabled, or set ALV_CLI_BINARY_PATH to a built apex-log-viewer binary. ${formatErrorCause(error)}`
    );
  }
}

function binaryNameForPlatform(platform: string): string {
  return platform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
}

function isJsonFlag(arg: string): boolean {
  return arg === '--json' || arg.startsWith('--json=');
}

function resolveRuntimeExitCode(result: RuntimeExecutionResult): number {
  if (typeof result.exitCode === 'number') {
    return result.exitCode;
  }
  return result.signal ? 1 : 0;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function extractJsonCandidate(value: string): string | undefined {
  const objectStart = value.indexOf('{');
  const arrayStart = value.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  if (starts.length === 0) {
    return undefined;
  }

  const start = Math.min(...starts);
  const objectEnd = value.lastIndexOf('}');
  const arrayEnd = value.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  return end > start ? value.slice(start, end + 1) : undefined;
}

function preview(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

function formatErrorCause(error: unknown): string {
  return error instanceof Error && error.message ? `Cause: ${error.message}` : '';
}
