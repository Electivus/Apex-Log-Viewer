import * as cp from 'child_process';
import * as os from 'os';
import { logTrace, logWarn } from '../utils/logger';
import { localize } from '../utils/localize';
const crossSpawn = require('cross-spawn');
import type { OrgAuth, OrgItem } from './types';

const CLI_TIMEOUT_MS = 30000;

// Allow swapping exec implementation in tests
export type ExecFileFn = (
  file: string,
  args: readonly string[] | undefined,
  options: cp.ExecFileOptionsWithStringEncoding,
  callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
) => cp.ChildProcess;

let execFileImpl: ExecFileFn = ((
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

export function __setExecFileImplForTests(fn: ExecFileFn): void {
  execFileImpl = fn;
}

export function __resetExecFileImplForTests(): void {
  execFileImpl = cp.execFile as unknown as ExecFileFn;
}

// Lazily resolve PATH from the user's login shell (macOS/Linux) to match Terminal/Cursor
let cachedLoginShellPATH: string | undefined;
let resolvingPATH: Promise<string | undefined> | null = null;

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

function execCommand(
  program: string,
  args: string[],
  envOverride?: NodeJS.ProcessEnv,
  timeoutMs: number = CLI_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
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
      if (error) {
        const err: any = error;
        if (err && (err.code === 'ENOENT' || /not found|ENOENT/i.test(err.message))) {
          const e = new Error(`CLI not found: ${program}`) as any;
          e.code = 'ENOENT';
          try {
            logTrace('execCommand ENOENT for', program);
          } catch {}
          reject(e);
          return;
        }
        try {
          logTrace('execCommand error for', program, '->', (stderr || err.message || '').split('\n')[0]);
        } catch {}
        reject(new Error(stderr || err.message));
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
      const err: any = new Error(
        localize('cliTimeout', 'Salesforce CLI command timed out after {0} seconds.', Math.round(timeoutMs / 1000))
      );
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });
}

export async function getOrgAuth(targetUsernameOrAlias?: string): Promise<OrgAuth> {
  const t = targetUsernameOrAlias;
  const candidates: Array<{ program: string; args: string[] }> = [
    { program: 'sf', args: ['org', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'user', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'user', 'display', '--json', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'display', '--json', ...(t ? ['-o', t] : [])] },
    { program: 'sfdx', args: ['force:org:display', '--json', ...(t ? ['-u', t] : [])] }
  ];
  let sawEnoent = false;
  for (const { program, args } of candidates) {
    try {
      try {
        logTrace('getOrgAuth: trying', program, args.join(' '));
      } catch {}
      const { stdout } = await execCommand(program, args, undefined, CLI_TIMEOUT_MS);
      const parsed = JSON.parse(stdout);
      const result = parsed.result || parsed;
      const accessToken: string | undefined = result.accessToken || result.access_token;
      const instanceUrl: string | undefined = result.instanceUrl || result.instance_url || result.loginUrl;
      const username: string | undefined = result.username;
      if (accessToken && instanceUrl) {
        try {
          logTrace('getOrgAuth: success for user', username || '(unknown)', 'at', instanceUrl);
        } catch {}
        return { accessToken, instanceUrl, username };
      }
    } catch (_e) {
      const e: any = _e;
      if (e && e.code === 'ENOENT') {
        sawEnoent = true;
      } else if (e && e.code === 'ETIMEDOUT') {
        throw e;
      }
      try {
        logTrace('getOrgAuth: attempt failed for', program);
      } catch {}
    }
  }
  if (sawEnoent) {
    const loginPath = await resolvePATHFromLoginShell();
    if (loginPath) {
      const env2: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
      for (const { program, args } of candidates) {
        try {
          try {
            logTrace('getOrgAuth(login PATH): trying', program, args.join(' '));
          } catch {}
          const { stdout } = await execCommand(program, args, env2, CLI_TIMEOUT_MS);
          const parsed = JSON.parse(stdout);
          const result = parsed.result || parsed;
          const accessToken: string | undefined = result.accessToken || result.access_token;
          const instanceUrl: string | undefined = result.instanceUrl || result.instance_url || result.loginUrl;
          const username: string | undefined = result.username;
          if (accessToken && instanceUrl) {
            try {
              logTrace('getOrgAuth(login PATH): success for user', username || '(unknown)', 'at', instanceUrl);
            } catch {}
            return { accessToken, instanceUrl, username };
          }
        } catch (_e) {
          const e: any = _e;
          if (e && e.code === 'ETIMEDOUT') {
            throw e;
          }
          try {
            logTrace('getOrgAuth(login PATH): attempt failed for', program);
          } catch {}
        }
      }
    }
    throw new Error(
      localize('cliNotFound', 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).')
    );
  }
  throw new Error(
    localize(
      'cliAuthFailed',
      'Could not obtain credentials via sf/sfdx CLI. Verify authentication and try: sf org display --json --verbose'
    )
  );
}

function parseOrgList(json: string): OrgItem[] {
  const parsed = JSON.parse(json);
  const res = parsed.result || parsed;
  let groups: any[] = [];
  if (Array.isArray(res.orgs)) {
    groups = groups.concat(res.orgs);
  }
  if (Array.isArray(res.nonScratchOrgs)) {
    groups = groups.concat(res.nonScratchOrgs);
  }
  if (Array.isArray(res.scratchOrgs)) {
    groups = groups.concat(res.scratchOrgs);
  }
  if (Array.isArray(res.sandboxes)) {
    groups = groups.concat(res.sandboxes);
  }
  if (Array.isArray(res.devHubs)) {
    groups = groups.concat(res.devHubs);
  }
  const map = new Map<string, OrgItem>();
  for (const o of groups) {
    const username: string | undefined = o.username || o.usernameOrAlias || o.usernameOrEmail;
    if (!username) {
      continue;
    }
    const item: OrgItem = {
      username,
      alias: o.alias,
      isDefaultUsername: !!(o.isDefaultUsername || o.isDefault),
      isDefaultDevHubUsername: !!o.isDefaultDevHubUsername,
      isScratchOrg: !!(o.isScratchOrg || o.isScratch)
    };
    if (o.instanceUrl) {
      item.instanceUrl = o.instanceUrl;
    }
    map.set(username, Object.assign(map.get(username) || {}, item));
  }
  if (Array.isArray(res.results)) {
    for (const o of res.results) {
      const username: string | undefined = o.username;
      if (!username) {
        continue;
      }
      const prev = map.get(username) || ({ username } as OrgItem);
      const updated: OrgItem = {
        ...prev,
        alias: prev.alias || o.alias,
        isDefaultUsername: prev.isDefaultUsername || !!o.isDefaultUsername,
        isDefaultDevHubUsername: prev.isDefaultDevHubUsername || !!o.isDefaultDevHubUsername,
        isScratchOrg: prev.isScratchOrg || !!o.isScratchOrg,
        instanceUrl: prev.instanceUrl || o.instanceUrl
      };
      map.set(username, updated);
    }
  }
  const arr = Array.from(map.values());
  arr.sort((a, b) => {
    const ad = a.isDefaultUsername ? 0 : 1;
    const bd = b.isDefaultUsername ? 0 : 1;
    if (ad !== bd) {
      return ad - bd;
    }
    const an = (a.alias || a.username).toLowerCase();
    const bn = (b.alias || b.username).toLowerCase();
    return an.localeCompare(bn);
  });
  return arr;
}

// Simple in-memory cache for listOrgs
interface OrgsCache {
  data: OrgItem[];
  expiresAt: number;
}

let orgsCache: OrgsCache | undefined;
let orgsCacheTtl = 10000; // 10s default

export function __setListOrgsCacheTTLForTests(ms: number): void {
  orgsCacheTtl = ms;
}

export function __resetListOrgsCacheForTests(): void {
  orgsCache = undefined;
  orgsCacheTtl = 10000;
}

export async function listOrgs(forceRefresh = false): Promise<OrgItem[]> {
  const now = Date.now();
  if (!forceRefresh && orgsCache && orgsCache.expiresAt > now) {
    return orgsCache.data;
  }
  const candidates: Array<{ program: string; args: string[] }> = [
    { program: 'sf', args: ['org', 'list', '--json'] },
    { program: 'sfdx', args: ['force:org:list', '--json'] }
  ];
  let sawEnoent = false;
  for (const { program, args } of candidates) {
    try {
      try {
        logTrace('listOrgs: trying', program, args.join(' '));
      } catch {}
      const { stdout } = await execCommand(program, args, undefined, CLI_TIMEOUT_MS);
      const res = parseOrgList(stdout);
      orgsCache = { data: res, expiresAt: now + orgsCacheTtl };
      return res;
    } catch (_e) {
      const e: any = _e;
      if (e && e.code === 'ENOENT') {
        sawEnoent = true;
      } else if (e && e.code === 'ETIMEDOUT') {
        throw e;
      }
      try {
        logTrace('listOrgs: attempt failed for', program);
      } catch {}
    }
  }
  if (sawEnoent) {
    const loginPath = await resolvePATHFromLoginShell();
    if (loginPath) {
      const env2: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
      for (const { program, args } of candidates) {
        try {
          try {
            logTrace('listOrgs(login PATH): trying', program, args.join(' '));
          } catch {}
          const { stdout } = await execCommand(program, args, env2, CLI_TIMEOUT_MS);
          const res = parseOrgList(stdout);
          orgsCache = { data: res, expiresAt: now + orgsCacheTtl };
          return res;
        } catch (_e) {
          const e: any = _e;
          if (e && e.code === 'ETIMEDOUT') {
            throw e;
          }
          try {
            logTrace('listOrgs(login PATH): attempt failed for', program);
          } catch {}
        }
      }
    }
    throw new Error(
      localize('cliNotFound', 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).')
    );
  }
  const empty: OrgItem[] = [];
  orgsCache = { data: empty, expiresAt: now + orgsCacheTtl };
  return empty;
}

export { parseOrgList as __parseOrgListForTests };
