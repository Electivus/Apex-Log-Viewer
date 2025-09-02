import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

/** Return the first workspace folder path, if any. */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0]!.uri.fsPath;
  }
  return undefined;
}

/** Resolve the logs directory path (workspace or temp) without creating it. */
export function getApexLogsDir(): string {
  const workspaceRoot = getWorkspaceRoot();
  const cfg = vscode.workspace.getConfiguration();
  // Read configured folder name; fallback to default when empty/invalid
  let dirName = String(cfg.get<string>('sfLogs.saveDirName') || '').trim();
  if (!dirName) {
    dirName = 'apexlogs';
  }
  // Sanitize directory name to avoid unsafe paths
  dirName = dirName.replace(/[^a-zA-Z0-9_.@\-]+/g, '_');
  if (!workspaceRoot) {
    return path.join(os.tmpdir(), dirName);
  }
  return path.join(workspaceRoot, dirName);
}

/** Ensure the logs folder exists (workspace or temp) and return its path. */
export async function ensureApexLogsDir(): Promise<string> {
  const dir = getApexLogsDir();
  const workspaceRoot = getWorkspaceRoot();
  await fs.mkdir(dir, { recursive: true });
  // Best-effort: add to .gitignore if present
  if (workspaceRoot) {
    try {
      const gitignorePath = path.join(workspaceRoot, '.gitignore');
      const dirName = path.basename(dir);
      const stat = await fs.stat(gitignorePath).catch(() => undefined as any);
      if (stat && stat.isFile()) {
        const content = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
        const lines = content.split(/\r?\n/).map(l => l.trim());
        const hasEntry = lines.some(
          l => l === dirName || l === `${dirName}/` || l === `/${dirName}` || l === `/${dirName}/`
        );
        if (!hasEntry) {
          await fs.appendFile(gitignorePath, (content.endsWith('\n') ? '' : '\n') + `${dirName}/\n`, 'utf8');
        }
      }
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
