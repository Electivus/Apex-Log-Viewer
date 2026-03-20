import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { logInfo, logWarn } from './logger';
import type { WorkspaceTarget } from '../shared/newWindowLaunch';

type WorkspaceSource = Pick<typeof vscode.workspace, 'workspaceFile' | 'workspaceFolders'>;

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

export function getCurrentWorkspaceTarget(workspace: WorkspaceSource = vscode.workspace): WorkspaceTarget | undefined {
  if (workspace.workspaceFile) {
    return { type: 'workspaceFile', uri: workspace.workspaceFile.toString() };
  }

  const firstFolder = workspace.workspaceFolders?.[0]?.uri;
  return firstFolder ? { type: 'folder', uri: firstFolder.toString() } : undefined;
}

export function workspaceTargetsEqual(left: WorkspaceTarget | undefined, right: WorkspaceTarget | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.uri === right.uri);
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
 * Build a username-prefixed log file path under `apexlogs`.
 */
export async function getLogFilePathWithUsername(
  username: string | undefined,
  logId: string
): Promise<{ dir: string; filePath: string }> {
  const dir = await ensureApexLogsDir();
  const safeUser = (username || 'default').replace(/[^a-zA-Z0-9_.@-]+/g, '_');
  const filePath = path.join(dir, `${safeUser}_${logId}.log`);
  return { dir, filePath };
}

/**
 * Find a previously saved log file (username-prefixed or legacy `<id>.log`).
 */
export async function findExistingLogFile(logId: string): Promise<string | undefined> {
  const dir = getApexLogsDir();
  try {
    const entries = await fs.readdir(dir);
    const preferred = entries.find(name => name.endsWith(`_${logId}.log`));
    if (preferred) {
      return path.join(dir, preferred);
    }
    const legacy = entries.find(name => name === `${logId}.log`);
    if (legacy) {
      return path.join(dir, legacy);
    }
  } catch {
    // ignore
  }
  return undefined;
}

const LOG_FILE_REGEX = /^(?:[a-zA-Z0-9_.@-]+_)?([a-zA-Z0-9]{15,18})\.log$/;

function extractLogIdFromFileName(fileName: string): string | undefined {
  if (!fileName.toLowerCase().endsWith('.log')) {
    return undefined;
  }
  const match = LOG_FILE_REGEX.exec(fileName);
  return match ? match[1] : undefined;
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
  const dir = getApexLogsDir();
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      return 0;
    }
    throw e;
  }
  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      continue;
    }
    const logId = extractLogIdFromFileName(entry.name);
    if (!logId) {
      continue;
    }
    if (keepIds?.has(logId)) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
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
