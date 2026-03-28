import * as os from 'os';
import * as path from 'path';
import { logTrace } from '../utils/logger';
import { execFileImpl } from './exec';

const WINDOWS_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

// Lazily resolve PATH from the user's login shell (macOS/Linux) to match Terminal/Cursor
let cachedLoginShellPATH: string | undefined;
let resolvingPATH: Promise<string | undefined> | null = null;
let cachedSfCliPath: string | undefined;
let resolvingSfCliPath: Promise<string | undefined> | null = null;

export function __resetLoginShellPATHForTests(): void {
  cachedLoginShellPATH = undefined;
  resolvingPATH = null;
  cachedSfCliPath = undefined;
  resolvingSfCliPath = null;
}

export async function resolvePATHFromLoginShell(): Promise<string | undefined> {
  if (cachedLoginShellPATH) {
    return cachedLoginShellPATH;
  }
  if (resolvingPATH) {
    return resolvingPATH;
  }
  resolvingPATH = resolvePATHFromLoginShellInner().finally(() => {
    resolvingPATH = null;
  });
  return resolvingPATH;
}

export async function getLoginShellEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  const loginPath = await resolvePATHFromLoginShell();
  const env2: NodeJS.ProcessEnv = { ...process.env };
  if (loginPath) {
    env2.PATH = loginPath;
    env2.Path = loginPath;
  }
  const sfCliPath = await resolveSfCliPath(env2);
  if (sfCliPath) {
    env2.ALV_SF_BIN_PATH = sfCliPath;
  }
  return loginPath || sfCliPath ? env2 : undefined;
}

async function resolvePATHFromLoginShellInner(): Promise<string | undefined> {
  const currentPath = process.env.PATH || process.env.Path;
  for (const { program, args } of getPathProbeCommands()) {
    const pathFromShell = await execPathProbe(program, args);
    if (!pathFromShell || pathFromShell === currentPath) {
      try {
        logTrace('resolvePATHFromLoginShell: no change');
      } catch {}
      continue;
    }
    cachedLoginShellPATH = pathFromShell;
    try {
      logTrace('resolvePATHFromLoginShell: resolved length', cachedLoginShellPATH.length);
    } catch {}
    return cachedLoginShellPATH;
  }
  return undefined;
}

function getPathProbeCommands(): Array<{ program: string; args: string[] }> {
  if (os.platform() === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    return [
      {
        program: 'pwsh',
        args: ['-NoLogo', '-Login', '-Command', '$env:PATH']
      },
      {
        program: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoLogo', '-Login', '-Command', '$env:PATH']
      }
    ];
  }

  const shell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return [
    {
      program: shell,
      args: ['-ilc', 'command -v printenv >/dev/null 2>&1 && printenv PATH || echo -n "$PATH"']
    }
  ];
}

async function execPathProbe(program: string, args: string[]): Promise<string | undefined> {
  return execProbe(program, args);
}

async function resolveSfCliPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (os.platform() !== 'win32') {
    return undefined;
  }
  if (cachedSfCliPath) {
    return cachedSfCliPath;
  }
  if (resolvingSfCliPath) {
    return resolvingSfCliPath;
  }
  resolvingSfCliPath = resolveSfCliPathInner(env).finally(() => {
    resolvingSfCliPath = null;
  });
  return resolvingSfCliPath;
}

async function resolveSfCliPathInner(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const command = process.env.ComSpec || 'cmd.exe';
  const output = await execProbe(command, ['/d', '/s', '/c', 'where sf'], env);
  cachedSfCliPath = pickPreferredSfCliPath(output);
  if (cachedSfCliPath) {
    return cachedSfCliPath;
  }

  const gitBashResolved = await execProbe(
    WINDOWS_GIT_BASH,
    [
      '-lc',
      'command -v sf.cmd >/dev/null 2>&1 && cygpath -w "$(command -v sf.cmd)" || command -v sf >/dev/null 2>&1 && cygpath -w "$(command -v sf)"'
    ],
    env
  );
  cachedSfCliPath = pickPreferredSfCliPath(gitBashResolved);
  return cachedSfCliPath;
}

function pickPreferredSfCliPath(output: string | undefined): string | undefined {
  const candidates = String(output || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  return candidates.find(value => value.toLowerCase().endsWith('.cmd')) || candidates[0] || undefined;
}

async function execProbe(program: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise<string | undefined>(resolve => {
    try {
      logTrace('resolvePATHFromLoginShell: spawn', program, args.join(' '));
    } catch {}
    execFileImpl(program, args, { env, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, _stderr) => {
      if (error) {
        try {
          logTrace('resolvePATHFromLoginShell: failed');
        } catch {}
        resolve(undefined);
        return;
      }
      resolve(String(stdout || '').trim() || undefined);
    });
  });
}
