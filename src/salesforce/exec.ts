import * as cp from 'child_process';
import { logTrace, logWarn } from '../utils/logger';
import { localize } from '../utils/localize';
import { safeSendException } from '../shared/telemetry';
const crossSpawn = require('cross-spawn');

export const CLI_TIMEOUT_MS = 120000;

// Deduplicate identical execs running concurrently
const inFlightExecs = new Map<string, Promise<{ stdout: string; stderr: string }>>();

export function __resetExecDedupeCacheForTests(): void {
  inFlightExecs.clear();
}

export type ExecFileFn = (
  file: string,
  args: readonly string[] | undefined,
  options: cp.ExecFileOptionsWithStringEncoding,
  callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
) => cp.ChildProcess;

export let execFileImpl: ExecFileFn = ((
  file: string,
  args: readonly string[] | undefined,
  options: cp.ExecFileOptionsWithStringEncoding,
  callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
) => {
  const argv = Array.isArray(args) ? args.slice() : [];
  const spawnOpts: cp.SpawnOptions = { env: options.env };
  try {
    logTrace('spawn:', file, argv.join(' '));
  } catch {}
  const child = crossSpawn(file, argv, spawnOpts);
  let stdout = '';
  let stderr = '';
  const max = Math.max(1024 * 1024, options.maxBuffer || 1024 * 1024 * 10);
  const encoding = options.encoding || 'utf8';
  child.stdout?.setEncoding(encoding as BufferEncoding);
  child.stderr?.setEncoding(encoding as BufferEncoding);
  const onDataOut = (chunk: string) => {
    stdout += chunk;
    if (stdout.length + stderr.length > max) {
      try {
        child.kill();
      } catch {}
      const err: any = new Error('maxBuffer exceeded');
      process.nextTick(() => callback(err, stdout, stderr));
    }
  };
  const onDataErr = (chunk: string) => {
    stderr += chunk;
    if (stdout.length + stderr.length > max) {
      try {
        child.kill();
      } catch {}
      const err: any = new Error('maxBuffer exceeded');
      process.nextTick(() => callback(err, stdout, stderr));
    }
  };
  child.stdout?.on('data', onDataOut);
  child.stderr?.on('data', onDataErr);
  child.on('error', (error: any) => {
    const err: any = error instanceof Error ? error : new Error(String(error || 'spawn error'));
    process.nextTick(() => callback(err, stdout, stderr));
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (code === 0) {
      callback(null, stdout, stderr);
    } else {
      const err: any = new Error(stderr || `Command failed: ${file} ${argv.join(' ')}`);
      if (code !== null) {
        err.code = code;
      }
      if (signal) {
        err.signal = signal;
      }
      callback(err, stdout, stderr);
    }
  });
  return child as unknown as cp.ChildProcess;
}) as unknown as ExecFileFn;

export let execOverriddenForTests = false;
export let execOverrideGeneration = 0;

export function markExecOverriddenForTests(): void {
  execOverriddenForTests = true;
  execOverrideGeneration++;
}

export function markExecResetForTests(): void {
  execOverriddenForTests = false;
  execOverrideGeneration++;
}

export function __setExecFileImplForTests(fn: ExecFileFn): void {
  execFileImpl = fn;
  markExecOverriddenForTests();
}

export function __resetExecFileImplForTests(): void {
  execFileImpl = cp.execFile as unknown as ExecFileFn;
  markExecResetForTests();
}

function wrapWithAbort<T>(underlying: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return underlying;
  }
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {}
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    underlying.then(
      v => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
        if (!aborted) {
          resolve(v);
        }
      },
      err => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
        if (!aborted) {
          reject(err);
        }
      }
    );
  });
}

function makeExecKey(program: string, args: string[], envOverride?: NodeJS.ProcessEnv, timeoutMs?: number): string {
  const hasAltPath = !!(envOverride && envOverride.PATH && envOverride.PATH !== process.env.PATH);
  return [program, ...args, hasAltPath ? 'loginPATH' : '', String(timeoutMs || '')].join('\u0000');
}

export function execCommand(
  program: string,
  args: string[],
  envOverride?: NodeJS.ProcessEnv,
  timeoutMs: number = CLI_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const key = makeExecKey(program, args, envOverride, timeoutMs);
  const existing = inFlightExecs.get(key);
  if (existing) {
    // Return a per-caller wrapper that can be cancelled without aborting the shared process
    return wrapWithAbort(existing, signal);
  }
  const p = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const opts: cp.ExecFileOptionsWithStringEncoding = {
      maxBuffer: 1024 * 1024 * 10,
      encoding: 'utf8'
    };
    if (envOverride) {
      opts.env = envOverride;
    }
    try {
      logTrace('execCommand:', program, args.join(' '), envOverride?.PATH ? '(login PATH)' : '');
    } catch {}
    let finished = false;
    let timer: NodeJS.Timeout;
    const child = execFileImpl(program, args, opts, (error, stdout, stderr) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      inFlightExecs.delete(key);
      if (error) {
        const err: any = error;
        if (err && (err.code === 'ENOENT' || /not found|ENOENT/i.test(err.message))) {
          const cmdStr = [program, ...args].join(' ').trim();
          const e = new Error(`CLI not found: ${cmdStr}`) as any;
          e.code = 'ENOENT';
          try {
            logTrace('execCommand ENOENT for', program);
          } catch {}
          safeSendException('cli.exec', { code: 'ENOENT', command: program });
          reject(e);
          return;
        }
        try {
          logTrace('execCommand error for', program, '->', (stderr || err.message || '').split('\n')[0]);
        } catch {}
        safeSendException('cli.exec', { code: String(err.code || ''), command: program });
        const code = typeof err.code === 'number' || typeof err.code === 'string' ? err.code : undefined;
        const cmdStr2 = [program, ...args].join(' ').trim();
        const detail = stderr || err.message;
        const msg =
          code !== undefined
            ? `Command "${cmdStr2}" exited with code ${code}: ${detail}`
            : `Command "${cmdStr2}" failed: ${detail}`;
        const e: any = new Error(msg);
        if (code !== undefined) {
          (e as any).code = code;
        }
        reject(e);
        return;
      }
      try {
        logTrace('execCommand success for', program, '(stdout length', String(stdout || '').length, ')');
      } catch {}
      resolve({ stdout, stderr });
    });
    timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        child.kill();
      } catch {}
      try {
        logWarn('execCommand timeout for', program, args.join(' '));
      } catch {}
      const cmdStrTimeout = [program, ...args].join(' ').trim();
      const err: any = new Error(
        localize(
          'cliTimeout',
          'Salesforce CLI command timed out after {0} seconds: {1}',
          Math.round(timeoutMs / 1000),
          cmdStrTimeout
        )
      );
      err.code = 'ETIMEDOUT';
      inFlightExecs.delete(key);
      safeSendException('cli.exec', { code: 'ETIMEDOUT', command: program });
      reject(err);
    }, timeoutMs);
  });
  inFlightExecs.set(key, p);
  // Per-caller cancellation should not abort the shared underlying process
  return wrapWithAbort(p, signal);
}
