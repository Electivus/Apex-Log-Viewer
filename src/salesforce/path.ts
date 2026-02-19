import * as os from 'os';
import { logTrace } from '../utils/logger';
import { execFileImpl } from './exec';

// Lazily resolve PATH from the user's login shell (macOS/Linux) to match Terminal/Cursor
let cachedLoginShellPATH: string | undefined;
let resolvingPATH: Promise<string | undefined> | null = null;

export function __resetLoginShellPATHForTests(): void {
  cachedLoginShellPATH = undefined;
  resolvingPATH = null;
}

export async function resolvePATHFromLoginShell(): Promise<string | undefined> {
  if (os.platform() === 'win32') {
    return undefined;
  }
  if (cachedLoginShellPATH) {
    return cachedLoginShellPATH;
  }
  if (resolvingPATH) {
    return resolvingPATH;
  }
  resolvingPATH = new Promise<string | undefined>(resolve => {
    const shell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const args = ['-ilc', 'command -v printenv >/dev/null 2>&1 && printenv PATH || echo -n "$PATH"'];
    try {
      logTrace('resolvePATHFromLoginShell: spawn', shell, args.join(' '));
    } catch {}
    execFileImpl(shell, args, { maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, _stderr) => {
      if (error) {
        try {
          logTrace('resolvePATHFromLoginShell: failed');
        } catch {}
        resolve(undefined);
        return;
      }
      const pathFromShell = String(stdout || '').trim();
      if (!pathFromShell || pathFromShell === process.env.PATH) {
        try {
          logTrace('resolvePATHFromLoginShell: no change');
        } catch {}
        resolve(undefined);
        return;
      }
      cachedLoginShellPATH = pathFromShell;
      try {
        logTrace('resolvePATHFromLoginShell: resolved length', cachedLoginShellPATH.length);
      } catch {}
      resolve(cachedLoginShellPATH);
    });
  }).finally(() => {
    resolvingPATH = null;
  });
  return resolvingPATH;
}

export async function getLoginShellEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  const loginPath = await resolvePATHFromLoginShell();
  if (loginPath) {
    const env2: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
    return env2;
  }
  return undefined;
}
