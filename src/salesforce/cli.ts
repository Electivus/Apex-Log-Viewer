import * as cp from 'child_process';
import * as os from 'os';
import { logTrace, logWarn } from '../utils/logger';
import { localize } from '../utils/localize';
import { sendException } from '../shared/telemetry';
const crossSpawn = require('cross-spawn');
import type { OrgAuth, OrgItem } from './types';
import * as vscode from 'vscode';
import { CacheManager } from '../utils/cacheManager';
import { getBooleanConfig, getNumberConfig, getCliPath } from '../utils/config';

const CLI_TIMEOUT_MS = 120000;

// Deduplicate identical execs running concurrently
const inFlightExecs = new Map<string, Promise<{ stdout: string; stderr: string }>>();

function makeExecKey(program: string, args: string[], envOverride?: NodeJS.ProcessEnv, timeoutMs?: number): string {
  const hasAltPath = !!(envOverride && envOverride.PATH && envOverride.PATH !== process.env.PATH);
  return [program, ...args, hasAltPath ? 'loginPATH' : '', String(timeoutMs || '')].join('\u0000');
}

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

let execOverriddenForTests = false;
let execOverrideGeneration = 0;

export function __setExecFileImplForTests(fn: ExecFileFn): void {
  execFileImpl = fn;
  execOverriddenForTests = true;
  execOverrideGeneration++;
}

export function __resetExecFileImplForTests(): void {
  execFileImpl = cp.execFile as unknown as ExecFileFn;
  execOverriddenForTests = false;
  execOverrideGeneration++;
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
  const key = makeExecKey(program, args, envOverride, timeoutMs);
  const existing = inFlightExecs.get(key);
  if (existing) {
    return existing;
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
          const e = new Error(`CLI not found: ${program}`) as any;
          e.code = 'ENOENT';
          try {
            logTrace('execCommand ENOENT for', program);
          } catch {}
          try {
            sendException('cli.exec', { code: 'ENOENT', command: program });
          } catch {}
          reject(e);
          return;
        }
        try {
          logTrace('execCommand error for', program, '->', (stderr || err.message || '').split('\n')[0]);
        } catch {}
        try {
          sendException('cli.exec', { code: String(err.code || ''), command: program });
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
      inFlightExecs.delete(key);
      try {
        sendException('cli.exec', { code: 'ETIMEDOUT', command: program });
      } catch {}
      reject(err);
    }, timeoutMs);
  });
  inFlightExecs.set(key, p);
  return p;
}

// Short-lived in-memory cache for auth (avoid storing tokens on disk)
type AuthCache = { value: OrgAuth; expiresAt: number };
const authCacheByUser = new Map<string, AuthCache>();
const MAX_AUTH_CACHE_ITEMS = 50;
const AUTH_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let authCacheCleanupTimer: NodeJS.Timeout | undefined;

function purgeExpiredAuthCache(now: number = Date.now()): void {
  for (const [key, { expiresAt }] of authCacheByUser) {
    if (expiresAt <= now) {
      authCacheByUser.delete(key);
    }
  }
}

function scheduleAuthCacheCleanup(): void {
  if (authCacheCleanupTimer) {
    return;
  }
  authCacheCleanupTimer = setInterval(() => purgeExpiredAuthCache(), AUTH_CACHE_CLEANUP_INTERVAL_MS);
  authCacheCleanupTimer.unref?.();
}

function enforceAuthCacheLimit(): void {
  if (authCacheByUser.size <= MAX_AUTH_CACHE_ITEMS) {
    return;
  }
  const entries = Array.from(authCacheByUser.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  while (authCacheByUser.size > MAX_AUTH_CACHE_ITEMS && entries.length) {
    const [key] = entries.shift()!;
    authCacheByUser.delete(key);
  }
}

function getCliCacheConfig() {
  try {
    const enabled = getBooleanConfig('sfLogs.cliCache.enabled', true);
    const authTtl =
      Math.max(0, getNumberConfig('sfLogs.cliCache.authTtlSeconds', 0, 0, Number.MAX_SAFE_INTEGER)) * 1000;
    const orgsTtl =
      Math.max(0, getNumberConfig('sfLogs.cliCache.orgListTtlSeconds', 86400, 0, Number.MAX_SAFE_INTEGER)) * 1000;
    const authPersistTtl =
      Math.max(0, getNumberConfig('sfLogs.cliCache.authPersistentTtlSeconds', 86400, 0, Number.MAX_SAFE_INTEGER)) *
      1000;
    return { enabled, authTtl, orgsTtl, authPersistTtl };
  } catch {
    return { enabled: true, authTtl: 0, orgsTtl: 86400000, authPersistTtl: 86400000 };
  }
}

export async function getOrgAuth(targetUsernameOrAlias?: string, forceRefresh?: boolean): Promise<OrgAuth> {
  const t = targetUsernameOrAlias;
  const { enabled, authTtl, authPersistTtl } = getCliCacheConfig();
  const cacheKey = t || '__default__';
  const now = Date.now();
  purgeExpiredAuthCache(now);
  scheduleAuthCacheCleanup();
  if (execOverriddenForTests && !forceRefresh && authTtl > 0) {
    const cached = authCacheByUser.get(cacheKey);
    if (cached) {
      if (cached.expiresAt <= now) {
        authCacheByUser.delete(cacheKey);
      } else {
        try {
          logTrace('getOrgAuth: returning cached auth for', cacheKey);
        } catch {}
        return cached.value;
      }
    }
  }
  if (!forceRefresh && enabled && authPersistTtl > 0 && !execOverriddenForTests) {
    const persisted = CacheManager.get<OrgAuth>('cli', `orgAuth:${cacheKey}`);
    if (persisted && persisted.accessToken && persisted.instanceUrl) {
      try {
        logTrace('getOrgAuth: hit persistent cache for', cacheKey);
      } catch {}
      // refresh in-memory cache too
      if (authTtl > 0) {
        authCacheByUser.set(cacheKey, { value: persisted, expiresAt: now + authTtl });
        enforceAuthCacheLimit();
      }
      return persisted;
    }
  }
  const cli = getCliPath();
  const candidates: Array<{ program: string; args: string[] }> = cli
    ? [
        { program: cli, args: ['org', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
        { program: cli, args: ['org', 'user', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
        { program: cli, args: ['org', 'user', 'display', '--json', ...(t ? ['-o', t] : [])] },
        { program: cli, args: ['org', 'display', '--json', ...(t ? ['-o', t] : [])] }
      ]
    : [
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
        const auth = { accessToken, instanceUrl, username } as OrgAuth;
        if (execOverriddenForTests && authTtl > 0) {
          authCacheByUser.set(cacheKey, { value: auth, expiresAt: now + authTtl });
          enforceAuthCacheLimit();
        }
        if (enabled && authPersistTtl > 0 && !execOverriddenForTests) {
          try {
            await CacheManager.set('cli', `orgAuth:${cacheKey}`, auth, authPersistTtl);
          } catch {}
        }
        return auth;
      }
    } catch (_e) {
      const e: any = _e;
      if (e && e.code === 'ENOENT') {
        sawEnoent = true;
        try {
          sendException('cli.getOrgAuth', { code: 'ENOENT', command: program });
        } catch {}
      } else if (e && e.code === 'ETIMEDOUT') {
        try {
          sendException('cli.getOrgAuth', { code: 'ETIMEDOUT', command: program });
        } catch {}
        throw e;
      } else {
        try {
          sendException('cli.getOrgAuth', { code: String(e.code || ''), command: program });
        } catch {}
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
            const auth = { accessToken, instanceUrl, username } as OrgAuth;
            if (execOverriddenForTests && authTtl > 0) {
              authCacheByUser.set(cacheKey, { value: auth, expiresAt: now + authTtl });
              enforceAuthCacheLimit();
            }
            if (enabled && authPersistTtl > 0 && !execOverriddenForTests) {
              try {
                await CacheManager.set('cli', `orgAuth:${cacheKey}`, auth, authPersistTtl);
              } catch {}
            }
            return auth;
          }
        } catch (_e) {
          const e: any = _e;
          if (e && e.code === 'ENOENT') {
            try {
              sendException('cli.getOrgAuth', { code: 'ENOENT', command: program });
            } catch {}
          } else if (e && e.code === 'ETIMEDOUT') {
            try {
              sendException('cli.getOrgAuth', { code: 'ETIMEDOUT', command: program });
            } catch {}
            throw e;
          } else {
            try {
              sendException('cli.getOrgAuth', { code: String(e.code || ''), command: program });
            } catch {}
          }
          try {
            logTrace('getOrgAuth(login PATH): attempt failed for', program);
          } catch {}
        }
      }
    }
    sendException('cli.getOrgAuth', { code: 'CLI_NOT_FOUND' });
    throw new Error(
      localize('cliNotFound', 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).')
    );
  }
  sendException('cli.getOrgAuth', { code: 'AUTH_FAILED' });
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
  gen: number;
}

let orgsCache: OrgsCache | undefined;
let orgsCacheTtl = 10000; // 10s default

// Test hook to bypass CLI and provide deterministic results
let listOrgsMock: (() => OrgItem[] | Promise<OrgItem[]>) | undefined;

export function __setListOrgsCacheTTLForTests(ms: number): void {
  orgsCacheTtl = ms;
  // Avoid leaking previously cached data between tests when TTL changes
  orgsCache = undefined;
}

export function __resetListOrgsCacheForTests(): void {
  orgsCache = undefined;
  orgsCacheTtl = 10000;
  try {
    // Best-effort: clear persistent cache to avoid test leakage when extension is activated
    void CacheManager.delete('cli', 'orgList');
  } catch {}
  listOrgsMock = undefined;
}

export function __setListOrgsMockForTests(fn: (() => OrgItem[] | Promise<OrgItem[]>) | undefined): void {
  listOrgsMock = fn;
  execOverriddenForTests = true;
  execOverrideGeneration++;
}

export async function listOrgs(forceRefresh = false): Promise<OrgItem[]> {
  const now = Date.now();
  const { enabled, orgsTtl } = getCliCacheConfig();
  const persistentKey = 'orgList';
  if (!forceRefresh && enabled && orgsTtl > 0 && !execOverriddenForTests) {
    const persisted = CacheManager.get<OrgItem[]>('cli', persistentKey);
    if (persisted && Array.isArray(persisted)) {
      try {
        logTrace('listOrgs: hit persistent cache');
      } catch {}
      // Para produção, evitamos cache em memória; para testes, mantemos
      if (execOverriddenForTests) {
        orgsCache = { data: persisted, expiresAt: now + Math.max(0, orgsCacheTtl), gen: execOverrideGeneration };
      }
      return persisted;
    }
  }
  if (execOverriddenForTests && !forceRefresh && orgsCache && orgsCache.expiresAt > now) {
    if (execOverriddenForTests && orgsCache.gen !== execOverrideGeneration) {
      orgsCache = undefined;
    } else {
      return orgsCache.data;
    }
  }
  // When mocked in tests, use the provided function to get results
  if (execOverriddenForTests && listOrgsMock) {
    const res = await Promise.resolve(listOrgsMock());
    orgsCache = { data: res, expiresAt: now + orgsCacheTtl, gen: execOverrideGeneration };
    return res;
  }
  const cli = getCliPath();
  const candidates: Array<{ program: string; args: string[] }> = cli
    ? [{ program: cli, args: ['org', 'list', '--json'] }]
    : [
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
      if (execOverriddenForTests) {
        orgsCache = { data: res, expiresAt: now + orgsCacheTtl, gen: execOverrideGeneration };
      }
      if (enabled && orgsTtl > 0 && !execOverriddenForTests) {
        try {
          await CacheManager.set('cli', persistentKey, res, orgsTtl);
        } catch {}
      }
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
          if (execOverriddenForTests) {
            orgsCache = { data: res, expiresAt: now + orgsCacheTtl, gen: execOverrideGeneration };
          }
          if (enabled && orgsTtl > 0 && !execOverriddenForTests) {
            try {
              await CacheManager.set('cli', persistentKey, res, orgsTtl);
            } catch {}
          }
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
  if (execOverriddenForTests) {
    orgsCache = { data: empty, expiresAt: now + orgsCacheTtl, gen: execOverrideGeneration };
  }
  if (enabled && orgsTtl > 0 && !execOverriddenForTests) {
    try {
      await CacheManager.set('cli', persistentKey, empty, orgsTtl);
    } catch {}
  }
  return empty;
}

export { parseOrgList as __parseOrgListForTests };
