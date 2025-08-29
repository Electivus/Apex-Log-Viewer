import * as cp from 'child_process';
import * as os from 'os';
import * as https from 'https';
import { URL } from 'url';
import { logTrace } from './utils/logger';
import { localize } from './utils/localize';
const crossSpawn = require('cross-spawn');
import type { ApexLogRow as SApexLogRow, OrgItem as SOrgItem } from './shared/types';
type ApexLogRow = SApexLogRow;
type OrgItem = SOrgItem;

// Reuse HTTP(S) connections between calls
const agent = new https.Agent({ keepAlive: true });

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
};

export type { SApexLogRow as ApexLogRow, SOrgItem as OrgItem };

// Allow swapping exec implementation in tests
type ExecFileFn = (
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
  // Map execFile-style options to spawn options
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
  resolvingPATH.finally(() => {
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
  envOverride?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const opts: cp.ExecFileOptionsWithStringEncoding = { maxBuffer: 1024 * 1024 * 10, encoding: 'utf8' };
    if (envOverride) {
      opts.env = envOverride;
    }
    try {
      logTrace('execCommand:', program, args.join(' '), envOverride?.PATH ? '(login PATH)' : '');
    } catch {}
    execFileImpl(program, args, opts, (error, stdout, stderr) => {
      if (error) {
        // Map ENOENT to a clearer message for missing CLI
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
  });
}

export async function getOrgAuth(targetUsernameOrAlias?: string): Promise<OrgAuth> {
  // Build candidates, attempting to specify target org when provided
  const t = targetUsernameOrAlias;
  const candidates: Array<{ program: string; args: string[] }> = [
    { program: 'sf', args: ['org', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'user', 'display', '--json', '--verbose', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'user', 'display', '--json', ...(t ? ['-o', t] : [])] },
    { program: 'sf', args: ['org', 'display', '--json', ...(t ? ['-o', t] : [])] },
    // Fallback to SFDX (legacy)
    { program: 'sfdx', args: ['force:org:display', '--json', ...(t ? ['-u', t] : [])] }
  ];
  let sawEnoent = false;
  for (const { program, args } of candidates) {
    try {
      try {
        logTrace('getOrgAuth: trying', program, args.join(' '));
      } catch {}
      const { stdout } = await execCommand(program, args);
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
      }
      try {
        logTrace('getOrgAuth: attempt failed for', program);
      } catch {}
      // try next variation
    }
  }
  // Fallback: retry with login shell PATH (macOS/Linux)
  if (sawEnoent) {
    const loginPath = await resolvePATHFromLoginShell();
    if (loginPath) {
      const env2: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath };
      for (const { program, args } of candidates) {
        try {
          try {
            logTrace('getOrgAuth(login PATH): trying', program, args.join(' '));
          } catch {}
          const { stdout } = await execCommand(program, args, env2);
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
        } catch {
          try {
            logTrace('getOrgAuth(login PATH): attempt failed for', program);
          } catch {}
          // try next
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

export async function listOrgs(): Promise<OrgItem[]> {
  // Try the new CLI and fall back to sfdx
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
      const { stdout } = await execCommand(program, args);
      const parsed = JSON.parse(stdout);
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
      // Some CLIs return the alias separately under a different key
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
      // Sort: default first, then alias alphabetically, then username
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
    } catch (_e) {
      const e: any = _e;
      if (e && e.code === 'ENOENT') {
        sawEnoent = true;
      }
      try {
        logTrace('listOrgs: attempt failed for', program);
      } catch {}
      // try next
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
          const { stdout } = await execCommand(program, args, env2);
          const parsed = JSON.parse(stdout);
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
        } catch {
          try {
            logTrace('listOrgs(login PATH): attempt failed for', program);
          } catch {}
          // try next
        }
      }
    }
    throw new Error(
      localize('cliNotFound', 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).')
    );
  }
  return [];
}

function httpsRequest(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const req = https.request(
      {
        method,
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        protocol: urlObj.protocol,
        headers,
        agent
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data });
        });
      }
    );
    req.on('error', reject);
    if (body && method !== 'GET' && method !== 'HEAD') {
      try {
        req.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
      } catch {}
      req.write(body, 'utf8');
    }
    req.end();
  });
}

async function refreshAuthInPlace(auth: OrgAuth): Promise<void> {
  try {
    const next = await getOrgAuth(auth.username);
    auth.accessToken = next.accessToken;
    auth.instanceUrl = next.instanceUrl;
    auth.username = next.username;
  } catch {
    // surface original 401 if refresh fails
  }
}

async function httpsRequestWith401Retry(
  auth: OrgAuth,
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body?: string
): Promise<string> {
  try {
    logTrace('HTTP', method, urlString);
  } catch {}
  const first = await httpsRequest(method, urlString, headers, body);
  try {
    logTrace('HTTP <-', first.statusCode, urlString);
  } catch {}
  if (first.statusCode === 401) {
    try {
      logTrace('HTTP 401 -> refreshing auth and retrying');
    } catch {}
    await refreshAuthInPlace(auth);
    const second = await httpsRequest(
      method,
      urlString,
      { ...headers, Authorization: `Bearer ${auth.accessToken}` },
      body
    );
    try {
      logTrace('HTTP(retry) <-', second.statusCode, urlString);
    } catch {}
    if (second.statusCode >= 200 && second.statusCode < 300) {
      return second.body;
    }
    throw new Error(`HTTP ${second.statusCode}: ${second.body}`);
  }
  if (first.statusCode >= 200 && first.statusCode < 300) {
    return first.body;
  }
  throw new Error(`HTTP ${first.statusCode}: ${first.body}`);
}

let API_VERSION = '64.0';

export function setApiVersion(v?: string): void {
  const s = (v || '').trim();
  if (/^\d+\.\d+$/.test(s)) {
    API_VERSION = s;
  }
}

export function getApiVersion(): string {
  return API_VERSION;
}

// In-memory cache
// - Log list: short TTL (avoid immediate refetch)
// - Each log's head: no TTL (logs are immutable after creation)
type ListCacheEntry = { expiresAt: number; data: ApexLogRow[] };
const listCache = new Map<string, ListCacheEntry>();
// Store the largest prefix of lines fetched per log; smaller requests return a slice
const headCacheByLog = new Map<string, string[]>();
const HEAD_CACHE_LIMIT = 200;
const HEAD_MAX_LINES = 100;

function makeListKey(auth: OrgAuth, limit: number, offset: number): string {
  return `${auth.instanceUrl}|${auth.username ?? ''}|${limit}|${offset}`;
}

function makeLogKey(auth: OrgAuth, logId: string): string {
  // Include username to avoid cache collisions between orgs on the same instanceUrl
  return `${auth.instanceUrl}|${auth.username ?? ''}|${logId}`;
}

export function clearListCache(): void {
  listCache.clear();
}

export async function fetchApexLogs(
  auth: OrgAuth,
  limit: number = 50,
  offset: number = 0,
  debugLevel?: string
): Promise<ApexLogRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  // Attempt cache with short TTL when no debug level filter
  const cacheKey = debugLevel ? undefined : makeListKey(auth, safeLimit, safeOffset);
  const now = Date.now();
  if (cacheKey) {
    const cached = listCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
  }
  const soql = encodeURIComponent(
    `SELECT Id, StartTime, Operation, Application, DurationMilliseconds, Status, Request, LogLength, LogUser.Name FROM ApexLog ORDER BY StartTime DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  const records = (json.records || []) as ApexLogRow[];
  // Do not filter by debug level here. ApexLog does not reliably carry
  // DebugLevel information, and filtering by Application was dropping
  // valid results causing 0 logs to appear even with a 200 response.
  // If needed, filtering should be applied client-side based on content.
  // Set a 3-second TTL for the specific page
  if (cacheKey) {
    listCache.set(cacheKey, { data: records, expiresAt: now + 3000 });
  }
  return records;
}

export async function fetchApexLogBody(auth: OrgAuth, logId: string): Promise<string> {
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
  const text = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'text/plain'
  });
  return text;
}

export async function listDebugLevels(auth: OrgAuth): Promise<string[]> {
  const soql = encodeURIComponent('SELECT DeveloperName FROM DebugLevel ORDER BY DeveloperName');
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  return (json.records || []).map((r: any) => r?.DeveloperName).filter((n: any): n is string => typeof n === 'string');
}

export async function getActiveUserDebugLevel(auth: OrgAuth): Promise<string | undefined> {
  // Resolve current user's Id from username, then look up the latest TraceFlag.
  // Query User via standard REST query endpoint.
  const username = (auth.username || '').trim();
  if (!username) {
    return undefined;
  }
  const esc = username.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${esc}' LIMIT 1`);
  const userUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}/query?q=${userSoql}`;
  const userBody = await httpsRequestWith401Retry(auth, 'GET', userUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const userJson = JSON.parse(userBody);
  const userId: string | undefined = Array.isArray(userJson.records) ? userJson.records[0]?.Id : undefined;
  if (!userId) {
    return undefined;
  }
  // Fetch most recent TraceFlag for the user; avoid IsActive (not present on all orgs)
  const tfSoql = encodeURIComponent(
    `SELECT DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId = '${userId}' ORDER BY CreatedDate DESC LIMIT 1`
  );
  const tfUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${tfSoql}`;
  const tfBody = await httpsRequestWith401Retry(auth, 'GET', tfUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const tfJson = JSON.parse(tfBody);
  const rec = (tfJson.records || [])[0];
  return rec?.DebugLevel?.DeveloperName as string | undefined;
}

// Format date as Salesforce datetime: YYYY-MM-DDTHH:mm:ss.SSS+0000 (UTC)
function toSfDateTimeUTC(d: Date): string {
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:` +
    `${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}+0000`
  );
}

async function getCurrentUserId(auth: OrgAuth): Promise<string | undefined> {
  const username = (auth.username || '').trim();
  if (!username) {
    return undefined;
  }
  const esc = username.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const userSoql = encodeURIComponent(`SELECT Id FROM User WHERE Username = '${esc}' LIMIT 1`);
  const userUrl = `${auth.instanceUrl}/services/data/v${API_VERSION}/query?q=${userSoql}`;
  const userBody = await httpsRequestWith401Retry(auth, 'GET', userUrl, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const userJson = JSON.parse(userBody);
  const userId: string | undefined = Array.isArray(userJson.records) ? userJson.records[0]?.Id : undefined;
  return userId;
}

async function getDebugLevelIdByName(auth: OrgAuth, developerName: string): Promise<string | undefined> {
  const name = (developerName || '').trim();
  if (!name) {
    return undefined;
  }
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const soql = encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${esc}' LIMIT 1`);
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  const rec = (json.records || [])[0];
  return rec?.Id as string | undefined;
}

async function hasActiveTraceFlag(auth: OrgAuth, userId: string): Promise<boolean> {
  const now = toSfDateTimeUTC(new Date());
  const soql = encodeURIComponent(
    `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG' AND StartDate <= ${now} AND ExpirationDate > ${now} ORDER BY CreatedDate DESC LIMIT 1`
  );
  const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/query?q=${soql}`;
  const body = await httpsRequestWith401Retry(auth, 'GET', url, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json'
  });
  const json = JSON.parse(body);
  return Array.isArray(json.records) && json.records.length > 0;
}

export async function ensureUserTraceFlag(
  auth: OrgAuth,
  developerName: string,
  ttlMinutes: number = 30
): Promise<boolean> {
  // Returns true if created a new TraceFlag, false if one already active or not possible
  try {
    const userId = await getCurrentUserId(auth);
    if (!userId) {
      try {
        logTrace('ensureUserTraceFlag: no user id');
      } catch {}
      return false;
    }
    // If already active, do nothing
    if (await hasActiveTraceFlag(auth, userId)) {
      try {
        logTrace('ensureUserTraceFlag: active traceflag exists for user');
      } catch {}
      return false;
    }
    // Resolve DebugLevelId
    const debugLevelId = await getDebugLevelIdByName(auth, developerName);
    if (!debugLevelId) {
      try {
        logTrace('ensureUserTraceFlag: debug level not found for', developerName);
      } catch {}
      return false;
    }
    const now = new Date();
    const start = toSfDateTimeUTC(new Date(now.getTime() - 1000));
    const exp = toSfDateTimeUTC(new Date(now.getTime() + Math.max(1, ttlMinutes) * 60 * 1000));
    const url = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/TraceFlag`;
    const payload = {
      TracedEntityId: userId,
      LogType: 'DEVELOPER_LOG',
      DebugLevelId: debugLevelId,
      StartDate: start,
      ExpirationDate: exp
    } as any;
    const resBody = await httpsRequestWith401Retry(
      auth,
      'POST',
      url,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      JSON.stringify(payload)
    );
    const res = JSON.parse(resBody);
    if (res && res.success) {
      try {
        logTrace('ensureUserTraceFlag: created TraceFlag', res.id || '(unknown id)');
      } catch {}
      return true;
    }
    return false;
  } catch (_e) {
    // Swallow errors to avoid breaking tail; caller can log a warning
    return false;
  }
}

type RangeResponse = { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string };

async function fetchApexLogBytesRange(
  auth: OrgAuth,
  logId: string,
  start: number,
  endInclusive: number
): Promise<RangeResponse> {
  const urlString = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
  const first = await httpsRequest('GET', urlString, {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'text/plain',
    'Accept-Encoding': 'identity',
    Range: `bytes=${start}-${endInclusive}`
  });
  if (first.statusCode === 401) {
    await refreshAuthInPlace(auth);
    const second = await httpsRequest('GET', urlString, {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'text/plain',
      'Accept-Encoding': 'identity',
      Range: `bytes=${start}-${endInclusive}`
    });
    return { statusCode: second.statusCode, headers: second.headers, body: second.body };
  }
  return { statusCode: first.statusCode, headers: first.headers, body: first.body };
}

export async function fetchApexLogHead(
  auth: OrgAuth,
  logId: string,
  maxLines: number,
  logLengthBytes?: number
): Promise<string[]> {
  const key = makeLogKey(auth, logId);
  const cached = headCacheByLog.get(key);
  if (cached && cached.length >= maxLines) {
    return cached.slice(0, Math.max(0, maxLines));
  }

  // 1) Attempt Range with Accept-Encoding: identity
  try {
    const stride = typeof logLengthBytes === 'number' ? (logLengthBytes <= 4096 ? logLengthBytes : 8192) : 8192;
    try {
      logTrace('HTTP Range GET ApexLog head', logId, 'bytes=0-', Math.max(0, stride - 1));
    } catch {}
    const range = await fetchApexLogBytesRange(auth, logId, 0, Math.max(0, stride - 1));
    const contentEncoding = (range.headers['content-encoding'] || '').toString().toLowerCase();
    if (range.statusCode === 206 && (!contentEncoding || contentEncoding === 'identity')) {
      try {
        logTrace('HTTP Range <- 206 identity for', logId);
      } catch {}
      const lines = range.body.split(/\r?\n/);
      const toStore = cached ? (lines.length > cached.length ? lines : cached) : lines;
      headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
      if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
        const firstKey = headCacheByLog.keys().next().value as string | undefined;
        if (firstKey) {
          headCacheByLog.delete(firstKey);
        }
      }
      return lines.slice(0, Math.max(0, maxLines));
    }
    // If 200 or an unexpected encoding, fall back
  } catch (_e) {
    // ignore and attempt fallback
  }

  // 2) Fallback: stream and stop early when reaching maxLines
  return new Promise((resolve, reject) => {
    const urlString = `${auth.instanceUrl}/services/data/v${API_VERSION}/tooling/sobjects/ApexLog/${logId}/Body`;
    const urlObj = new URL(urlString);
    try {
      logTrace('HTTP stream GET ApexLog head', logId, '-> until', maxLines, 'lines');
    } catch {}
    let buffer = '';
    let collected: string[] = [];
    const attempt = (token: string) =>
      https.request(
        {
          method: 'GET',
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          protocol: urlObj.protocol,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
          agent
        },
        res => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            if (res.statusCode === 401) {
              // retry once with refreshed auth
              res.resume();
              refreshAuthInPlace(auth)
                .then(() => {
                  try {
                    logTrace('HTTP stream 401; retrying for', logId);
                  } catch {}
                  const req2 = attempt(auth.accessToken);
                  req2.on('error', reject);
                  req2.end();
                })
                .catch(() => reject(new Error(`HTTP ${res.statusCode}`)));
              return;
            }
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', chunk => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1 && collected.length < maxLines) {
              const line = buffer.slice(0, idx).replace(/\r$/, '');
              buffer = buffer.slice(idx + 1);
              collected.push(line);
              if (collected.length >= maxLines) {
                try {
                  req.destroy();
                } catch {}
                try {
                  logTrace('HTTP stream: collected max lines for', logId, '->', collected.length);
                } catch {}
                // Update cache with the largest collected prefix
                const toStore = cached ? (collected.length > cached.length ? collected : cached) : collected;
                headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
                if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
                  const firstKey = headCacheByLog.keys().next().value as string | undefined;
                  if (firstKey) {
                    headCacheByLog.delete(firstKey);
                  }
                }
                resolve(collected);
                return;
              }
            }
          });
          res.on('end', () => {
            if (buffer.length && collected.length < maxLines) {
              collected.push(buffer.replace(/\r$/, ''));
            }
            try {
              logTrace('HTTP stream end for', logId, 'collected', collected.length);
            } catch {}
            const sliced = collected.slice(0, maxLines);
            const toStore = cached ? (sliced.length > cached.length ? sliced : cached) : sliced;
            headCacheByLog.set(key, toStore.slice(0, HEAD_MAX_LINES));
            if (headCacheByLog.size > HEAD_CACHE_LIMIT) {
              const firstKey = headCacheByLog.keys().next().value as string | undefined;
              if (firstKey) {
                headCacheByLog.delete(firstKey);
              }
            }
            resolve(sliced);
          });
        }
      );
    const req = attempt(auth.accessToken);
    req.on('error', reject);
    req.end();
  });
}

export function extractCodeUnitStartedFromLines(lines: string[]): string | undefined {
  const re = /\|CODE_UNIT_STARTED\|\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1]) {
      const captured = m[1];
      // Return only the content after the last pipe
      const parts = captured
        .split('|')
        .map(s => s.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts[parts.length - 1];
      }
      return captured.trim();
    }
  }
  return undefined;
}
