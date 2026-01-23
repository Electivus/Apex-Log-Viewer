import { logTrace } from '../utils/logger';
import { localize } from '../utils/localize';
import { safeSendException } from '../shared/telemetry';
import type { OrgAuth, OrgItem } from './types';
import * as vscode from 'vscode';
import { CacheManager } from '../utils/cacheManager';
import { getBooleanConfig, getNumberConfig } from '../utils/config';
import {
  execCommand,
  CLI_TIMEOUT_MS,
  execOverriddenForTests,
  execOverrideGeneration,
  markExecOverriddenForTests
} from './exec';
import { resolvePATHFromLoginShell } from './path';

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

export async function getOrgAuth(
  targetUsernameOrAlias?: string,
  forceRefresh?: boolean,
  signal?: AbortSignal
): Promise<OrgAuth> {
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
      const { stdout } = await execCommand(program, args, undefined, CLI_TIMEOUT_MS, signal);
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
      if (signal?.aborted) {
        throw new Error('aborted');
      }
      if (e && e.code === 'ENOENT') {
        sawEnoent = true;
        safeSendException('cli.getOrgAuth', { code: 'ENOENT', command: program });
      } else if (e && e.code === 'ETIMEDOUT') {
        safeSendException('cli.getOrgAuth', { code: 'ETIMEDOUT', command: program });
        throw e;
      } else {
        safeSendException('cli.getOrgAuth', { code: String(e.code || ''), command: program });
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
          const { stdout } = await execCommand(program, args, env2, CLI_TIMEOUT_MS, signal);
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
          if (signal?.aborted) {
            throw new Error('aborted');
          }
          if (e && e.code === 'ENOENT') {
            safeSendException('cli.getOrgAuth', { code: 'ENOENT', command: program });
          } else if (e && e.code === 'ETIMEDOUT') {
            safeSendException('cli.getOrgAuth', { code: 'ETIMEDOUT', command: program });
            throw e;
          } else {
            safeSendException('cli.getOrgAuth', { code: String(e.code || ''), command: program });
          }
          try {
            logTrace('getOrgAuth(login PATH): attempt failed for', program);
          } catch {}
        }
      }
    }
    safeSendException('cli.getOrgAuth', { code: 'CLI_NOT_FOUND' });
    throw new Error(
      localize('cliNotFound', 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).')
    );
  }
  safeSendException('cli.getOrgAuth', { code: 'AUTH_FAILED' });
  throw new Error(
    localize(
      'cliAuthFailed',
      'Failed to retrieve Salesforce org authentication. Run "sf org login web" to authenticate.'
    )
  );
}

let listOrgsMock: (() => OrgItem[] | Promise<OrgItem[]>) | undefined;
let orgsCache: { data: OrgItem[]; expiresAt: number; gen: number } | undefined;
let orgsCacheTtl = 60 * 1000;

export function __resetListOrgsCacheForTests(): void {
  orgsCache = undefined;
  try {
    void CacheManager.delete('cli', 'orgList');
  } catch {}
  listOrgsMock = undefined;
  orgsCacheTtl = 60 * 1000;
}

export function __setListOrgsMockForTests(fn: (() => OrgItem[] | Promise<OrgItem[]>) | undefined): void {
  listOrgsMock = fn;
  markExecOverriddenForTests();
}

export function __setListOrgsCacheTTLForTests(ttl: number): void {
  orgsCacheTtl = ttl;
}

export async function listOrgs(forceRefresh = false, signal?: AbortSignal): Promise<OrgItem[]> {
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
      const { stdout } = await execCommand(program, args, undefined, CLI_TIMEOUT_MS, signal);
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
      if (signal?.aborted) {
        throw new Error('aborted');
      }
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
          const { stdout } = await execCommand(program, args, env2, CLI_TIMEOUT_MS, signal);
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
          if (signal?.aborted) {
            throw new Error('aborted');
          }
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

function parseOrgList(json: string): OrgItem[] {
  const parsed = JSON.parse(json);
  const result = parsed.result || parsed;
  const all: OrgItem[] = [];
  if (Array.isArray(result.orgs)) {
    all.push(...result.orgs);
  }
  if (Array.isArray(result.nonScratchOrgs)) {
    all.push(...result.nonScratchOrgs);
  }
  if (Array.isArray(result.scratchOrgs)) {
    all.push(...result.scratchOrgs);
  }
  if (Array.isArray(result.sandboxes)) {
    all.push(...result.sandboxes);
  }
  if (Array.isArray(result.devHubs)) {
    all.push(...result.devHubs);
  }
  if (Array.isArray(result.results)) {
    all.push(...result.results);
  }
  const dedup = new Map<string, OrgItem>();
  for (const o of all) {
    const key = o.username || o.alias || JSON.stringify(o);
    if (!dedup.has(key)) {
      dedup.set(key, o);
    }
  }
  const orgs = Array.from(dedup.values());
  orgs.sort((a, b) => {
    if (a.isDefaultUsername && !b.isDefaultUsername) {
      return -1;
    }
    if (!a.isDefaultUsername && b.isDefaultUsername) {
      return 1;
    }
    const aliasA = a.alias || a.username || '';
    const aliasB = b.alias || b.username || '';
    return aliasA.localeCompare(aliasB);
  });
  return orgs;
}

export { parseOrgList as __parseOrgListForTests };
