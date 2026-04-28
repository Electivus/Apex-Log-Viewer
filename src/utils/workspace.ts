import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { runtimeClient } from '../../apps/vscode-extension/src/runtime/runtimeClient';
import { logInfo, logWarn } from './logger';

export interface SalesforceProjectInfo {
  workspaceRoot: string;
  projectFilePath: string;
  sourceApiVersion?: string;
}

let gitignoreUpdateQueue: Promise<void> = Promise.resolve();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withGitignoreUpdateLock(operation: () => Promise<void>): Promise<void> {
  const current = gitignoreUpdateQueue.then(operation, operation);
  gitignoreUpdateQueue = current.catch(() => undefined);
  await current;
}

/** Return the first workspace folder path, if any. */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0]!.uri.fsPath;
  }
  return undefined;
}

/**
 * Find the first workspace folder that contains `sfdx-project.json`.
 *
 * The search order follows VS Code's multi-root workspace folder order so the
 * runtime matches the `workspaceContains:sfdx-project.json` activation behavior.
 */
export async function findSalesforceProjectInfo(
  workspaceFolders: readonly Pick<vscode.WorkspaceFolder, 'uri'>[] | undefined = vscode.workspace.workspaceFolders
): Promise<SalesforceProjectInfo | undefined> {
  for (const folder of workspaceFolders ?? []) {
    const workspaceRoot = folder.uri.fsPath;
    const projectFilePath = path.join(workspaceRoot, 'sfdx-project.json');

    let rawProject: string;
    try {
      rawProject = await fs.readFile(projectFilePath, 'utf8');
    } catch (error: any) {
      const code = String(error?.code || '');
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue;
      }
      continue;
    }

    try {
      const parsed = JSON.parse(rawProject);
      const sourceApiVersion =
        typeof parsed?.sourceApiVersion === 'string' && parsed.sourceApiVersion.trim().length > 0
          ? parsed.sourceApiVersion.trim()
          : undefined;
      return {
        workspaceRoot,
        projectFilePath,
        sourceApiVersion
      };
    } catch (error) {
      logWarn('Could not parse sfdx-project.json while scanning workspace roots ->', getErrorMessage(error));
    }
  }

  return undefined;
}

/** Resolve the `apexlogs` directory path (workspace or temp) without creating it. */
export function getApexLogsDir(): string {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return path.join(os.tmpdir(), 'apexlogs');
  }
  return path.join(workspaceRoot, 'apexlogs');
}

/** Ensure an `apexlogs` folder exists (workspace or temp) and return its path. */
export async function ensureApexLogsDir(): Promise<string> {
  const dir = getApexLogsDir();
  const workspaceRoot = getWorkspaceRoot();
  await fs.mkdir(dir, { recursive: true });
  // Best-effort: add to .gitignore if present
  if (workspaceRoot) {
    try {
      await withGitignoreUpdateLock(async () => {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        const stat = await fs.stat(gitignorePath).catch(() => undefined as any);
        if (stat && stat.isFile()) {
          const content = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
          const lines = content.split(/\r?\n/).map(l => l.trim());
          const hasEntry = lines.some(
            l => l === 'apexlogs' || l === 'apexlogs/' || l === '/apexlogs' || l === '/apexlogs/'
          );
          if (!hasEntry) {
            await fs.appendFile(gitignorePath, (content.endsWith('\n') ? '' : '\n') + 'apexlogs/\n', 'utf8');
          }
        }
      });
    } catch {
      // ignore – non-blocking convenience
    }
  }
  return dir;
}

/**
 * Build an org-first log file path under `apexlogs` without touching the filesystem.
 */
export function buildLogFilePathWithUsername(
  username: string | undefined,
  logId: string,
  startTime?: string
): { dir: string; filePath: string } {
  const rootDir = getApexLogsDir();
  const safeUser = toSafeLogUserName(username);
  const dir = path.join(rootDir, 'orgs', safeUser, 'logs', toLogDayDirName(startTime));
  const filePath = path.join(dir, `${logId}.log`);
  return { dir, filePath };
}

/**
 * Build an org-first log file path under `apexlogs` and ensure its directories exist.
 */
export async function getLogFilePathWithUsername(
  username: string | undefined,
  logId: string,
  startTime?: string
): Promise<{ dir: string; filePath: string }> {
  await ensureApexLogsDir();
  const { dir, filePath } = buildLogFilePathWithUsername(username, logId, startTime);
  await fs.mkdir(dir, { recursive: true });
  return { dir, filePath };
}

function toSafeLogUserName(username: string | undefined): string {
  return (username || 'default').replace(/[^a-zA-Z0-9_.@-]+/g, '_');
}

function toLogDayDirName(startTime: string | undefined): string {
  const value = typeof startTime === 'string' ? startTime.trim() : '';
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : 'unknown-date';
}

function isSupportedLogDayDirName(name: string): boolean {
  return name === 'unknown-date' || /^\d{4}-\d{2}-\d{2}$/.test(name);
}

async function findExistingLogFileInLogsDir(logsDir: string, logId: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSupportedLogDayDirName(entry.name)) {
      continue;
    }

    const candidate = path.join(logsDir, entry.name, `${logId}.log`);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing or unreadable candidates
    }
  }

  return undefined;
}

async function findExistingLogFileInOrgsDir(orgsDir: string, logId: string): Promise<string | undefined> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(orgsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const found = await findExistingLogFileInLogsDir(path.join(orgsDir, entry.name, 'logs'), logId);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/**
 * Find a previously saved log file in the org-first log cache.
 */
export async function findExistingLogFile(logId: string, username?: string): Promise<string | undefined> {
  const dir = getApexLogsDir();
  const workspaceRoot = getWorkspaceRoot();

  try {
    const resolved = await runtimeClient.resolveCachedLogPath({
      logId,
      username,
      workspaceRoot
    });
    if (typeof resolved.path === 'string' && resolved.path.trim().length > 0) {
      return resolved.path;
    }
  } catch (error) {
    logWarn('Workspace: runtime cached log lookup failed ->', getErrorMessage(error));
  }

  try {
    if (username) {
      const orgFirst = await findExistingLogFileInLogsDir(path.join(dir, 'orgs', toSafeLogUserName(username), 'logs'), logId);
      if (orgFirst) {
        return orgFirst;
      }
    } else {
      const orgFirst = await findExistingLogFileInOrgsDir(path.join(dir, 'orgs'), logId);
      if (orgFirst) {
        return orgFirst;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

const LOG_FILE_REGEX = /^([a-zA-Z0-9]{15,18})\.log$/;

function extractLogIdFromFileName(fileName: string): string | undefined {
  if (!fileName.toLowerCase().endsWith('.log')) {
    return undefined;
  }
  const match = LOG_FILE_REGEX.exec(fileName);
  return match ? match[1] : undefined;
}

function isPurgeCandidateFile(entry: import('fs').Dirent): boolean {
  return entry.isFile() && !entry.isSymbolicLink();
}

async function readPurgeDir(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return [];
    }
    logWarn('Workspace: failed to inspect cached log directory', dir, '->', error);
    return [];
  }
}

async function collectOrgFirstPurgeCandidatePaths(rootDir: string): Promise<string[]> {
  const orgsDir = path.join(rootDir, 'orgs');
  const candidates: string[] = [];

  for (const orgEntry of await readPurgeDir(orgsDir)) {
    if (!orgEntry.isDirectory()) {
      continue;
    }

    const logsDir = path.join(orgsDir, orgEntry.name, 'logs');
    for (const dayEntry of await readPurgeDir(logsDir)) {
      if (!dayEntry.isDirectory() || !isSupportedLogDayDirName(dayEntry.name)) {
        continue;
      }

      const dayDir = path.join(logsDir, dayEntry.name);
      for (const fileEntry of await readPurgeDir(dayDir)) {
        if (isPurgeCandidateFile(fileEntry)) {
          candidates.push(path.join(dayDir, fileEntry.name));
        }
      }
    }
  }

  return candidates;
}

export function getLogIdFromLogFilePath(filePath: string): string | undefined {
  const fileName = path.basename(filePath);
  return extractLogIdFromFileName(fileName);
}

export async function purgeSavedLogs(options: {
  keepIds?: Set<string>;
  maxAgeMs?: number;
  signal?: AbortSignal;
} = {}): Promise<number> {
  const { keepIds, maxAgeMs = 1000 * 60 * 60 * 24, signal } = options;
  if (signal?.aborted) {
    throw new Error('aborted');
  }
  let removed = 0;
  const now = Date.now();
  const candidatePaths = await collectOrgFirstPurgeCandidatePaths(getApexLogsDir());

  for (const filePath of candidatePaths) {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    const logId = getLogIdFromLogFilePath(filePath);
    if (!logId) {
      continue;
    }
    if (keepIds?.has(logId)) {
      continue;
    }
    try {
      if (typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs)) {
        const stat = await fs.stat(filePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) {
          continue;
        }
      }
      await fs.unlink(filePath);
      removed++;
    } catch (err) {
      logWarn('Workspace: failed to purge cached log', filePath, '->', err);
    }
  }
  if (removed > 0) {
    logInfo('Workspace: purged', removed, 'cached Apex log files');
  }
  return removed;
}

/** Heuristic check whether a TextDocument appears to be a Salesforce Apex log. */
export function isApexLogDocument(doc: vscode.TextDocument): boolean {
  const name = (doc.fileName || '').toLowerCase();
  if (!/\.log$/.test(name)) return false;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(10, doc.lineCount), 0));
  return /APEX_CODE\s*,/i.test(head) || /\|EXECUTION_STARTED\|/.test(head);
}
