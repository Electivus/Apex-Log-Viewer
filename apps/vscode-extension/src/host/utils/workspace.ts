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
