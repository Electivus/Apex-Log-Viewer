import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CliParseOptions = {
  projectDir?: string;
  sfBin?: string;
  debug?: boolean;
};

export type CliParseResult = {
  options: CliParseOptions;
  showHelp?: boolean;
  showVersion?: boolean;
  error?: string;
};

export function parseArgs(argv: string[]): CliParseResult {
  const options: CliParseOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--help':
      case '-h':
        return { options, showHelp: true };
      case '--version':
      case '-v':
        return { options, showVersion: true };
      case '--project-dir': {
        const value = argv[index + 1];
        if (!value) {
          return { options, error: 'Missing value for --project-dir' };
        }
        options.projectDir = value;
        index += 1;
        break;
      }
      case '--sf-bin': {
        const value = argv[index + 1];
        if (!value) {
          return { options, error: 'Missing value for --sf-bin' };
        }
        options.sfBin = value;
        index += 1;
        break;
      }
      case '--debug':
        options.debug = true;
        break;
      default:
        if (arg.startsWith('-')) {
          return { options, error: `Unknown argument: ${arg}` };
        }
        return { options, error: `Unexpected argument: ${arg}` };
    }
  }

  return { options };
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit' }
) => { once: (event: 'exit', cb: (code: number | null) => void) => void };

export type CliDeps = {
  spawn: SpawnFn;
  chdir: (dir: string) => void;
  log: (message: string) => void;
  exit: (code: number) => void;
};

const defaultDeps: CliDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  chdir: (dir) => process.chdir(dir),
  log: (message) => {
    process.stderr.write(`${message}\n`);
  },
  exit: (code) => process.exit(code)
};

export function resolveServerEntry(): string {
  const currentDir = new URL('.', import.meta.url);
  const here = fileURLToPath(currentDir);
  return path.resolve(here, '..', 'dist', 'index.js');
}

export function formatUsage(): string {
  return [
    'Usage: apex-log-viewer-mcp [options]',
    '',
    'Options:',
    '  --project-dir <path>   Set cwd for the MCP server',
    '  --sf-bin <path>        Path to sf binary (overrides SF_BIN)',
    '  --debug                Enable debug logging',
    '  -h, --help             Show this help text',
    '  -v, --version          Show version'
  ].join('\n');
}

export function formatVersion(): string {
  const version = process.env.npm_package_version ?? '0.0.0';
  return `apex-log-viewer-mcp ${version}`;
}

export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.showHelp) {
    deps.log(formatUsage());
    return 0;
  }

  if (parsed.showVersion) {
    deps.log(formatVersion());
    return 0;
  }

  if (parsed.error) {
    deps.log(parsed.error);
    deps.log(formatUsage());
    return 1;
  }

  if (parsed.options.projectDir) {
    deps.chdir(parsed.options.projectDir);
  }

  const env = { ...process.env };
  if (parsed.options.sfBin) {
    env.SF_BIN = parsed.options.sfBin;
  }

  const entry = resolveServerEntry();
  deps.log(`Starting apex-log-viewer-mcp`);
  deps.log(`cwd: ${process.cwd()}`);
  deps.log(`entry: ${entry}`);
  if (env.SF_BIN) deps.log(`SF_BIN: ${env.SF_BIN}`);

  const child = deps.spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'
  });

  return await waitForExit(child);
}

function waitForExit(child: { once: (event: 'exit', cb: (code: number | null) => void) => void }): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? 0));
  });
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => defaultDeps.exit(code))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      defaultDeps.log(message);
      defaultDeps.exit(1);
    });
}
