import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { logWarn } from './logger';

export interface SalesforceProjectInfo {
  workspaceRoot: string;
  projectFilePath: string;
  sourceApiVersion?: string;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Return the first workspace folder path, if any. */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0]!.uri.fsPath;
  }
  return undefined;
}

const SFDX_PROJECT_FILE = 'sfdx-project.json';

type WorkspaceFolders = readonly Pick<vscode.WorkspaceFolder, 'uri'>[] | undefined;

/**
 * The workspace folders that hold an `sfdx-project.json`, in VS Code's multi-root folder order. `text` is the
 * file's content, or undefined when the file exists but cannot be read.
 */
async function* foldersWithProjectFile(
  workspaceFolders: WorkspaceFolders
): AsyncGenerator<{ workspaceRoot: string; projectFilePath: string; text: string | undefined }> {
  for (const folder of workspaceFolders ?? []) {
    const workspaceRoot = folder.uri.fsPath;
    const projectFilePath = path.join(workspaceRoot, SFDX_PROJECT_FILE);
    let text: string | undefined;
    try {
      text = await fs.readFile(projectFilePath, 'utf8');
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '');
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        continue;
      }
    }
    yield { workspaceRoot, projectFilePath, text };
  }
}

/**
 * Find the first workspace folder that contains `sfdx-project.json`.
 *
 * The search order follows VS Code's multi-root workspace folder order so the
 * runtime matches the `workspaceContains:sfdx-project.json` activation behavior.
 */
export async function findSalesforceProjectInfo(
  workspaceFolders: WorkspaceFolders = vscode.workspace.workspaceFolders
): Promise<SalesforceProjectInfo | undefined> {
  for await (const { workspaceRoot, projectFilePath, text } of foldersWithProjectFile(workspaceFolders)) {
    if (text === undefined) {
      continue;
    }

    try {
      const parsed = JSON.parse(text);
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

/**
 * The directory Custom Logs hands core to find the project mapping: the first workspace folder that
 * holds an `sfdx-project.json` (even a broken one, so core reports it), else the first folder, which
 * core walks up from. `undefined` without a workspace means built-in sources only.
 */
export async function findCustomLogsProjectDir(
  workspaceFolders: WorkspaceFolders = vscode.workspace.workspaceFolders
): Promise<string | undefined> {
  for await (const { workspaceRoot } of foldersWithProjectFile(workspaceFolders)) {
    return workspaceRoot;
  }
  return workspaceFolders?.[0]?.uri.fsPath;
}

const PROJECT_FILE_CHANGE_DEBOUNCE_MS = 300;

/**
 * Calls `listener` once a burst of saves, creations or deletions of a workspace folder's
 * `sfdx-project.json` settles. Watchers follow workspace folders as they come and go.
 */
export function onSfdxProjectFileChanged(listener: () => void): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchers: vscode.Disposable[] = [];
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      listener();
    }, PROJECT_FILE_CHANGE_DEBOUNCE_MS);
  };
  const watchFolders = () => {
    vscode.Disposable.from(...watchers).dispose();
    watchers = (vscode.workspace.workspaceFolders ?? []).map(folder => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SFDX_PROJECT_FILE));
      return vscode.Disposable.from(
        watcher,
        watcher.onDidChange(schedule),
        watcher.onDidCreate(schedule),
        watcher.onDidDelete(schedule)
      );
    });
  };
  watchFolders();
  const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    watchFolders();
    schedule();
  });
  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    foldersChanged.dispose();
    vscode.Disposable.from(...watchers).dispose();
    watchers = [];
  });
}

const LOG_FILE_REGEX = /^([a-zA-Z0-9]{15,18})\.log$/;

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

/** Heuristic check whether a TextDocument appears to be a Salesforce Apex log. */
export function isApexLogDocument(doc: vscode.TextDocument): boolean {
  const name = (doc.fileName || '').toLowerCase();
  if (!/\.log$/.test(name)) return false;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(10, doc.lineCount), 0));
  return /APEX_CODE\s*,/i.test(head) || /\|EXECUTION_STARTED\|/.test(head);
}
