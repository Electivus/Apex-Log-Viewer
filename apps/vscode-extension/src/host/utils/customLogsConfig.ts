import * as path from 'path';
import * as vscode from 'vscode';
import { localize } from './localize';
import { findCustomLogsProjectDir } from './workspace';

const CUSTOM_LOGS_KEY_PATTERN = /"plugins"\s*:\s*\{[\s\S]*?"electivus"\s*:\s*\{[\s\S]*?("customLogs")/;

/** Offset of the `"customLogs"` key under `plugins.electivus`, or undefined when the file has no such mapping. */
export function findCustomLogsOffset(projectFileText: string): number | undefined {
  const match = CUSTOM_LOGS_KEY_PATTERN.exec(projectFileText);
  return match ? match.index + match[0].length - (match[1]?.length ?? 0) : undefined;
}

/** Opens the project's `sfdx-project.json`, at the Custom Logs mapping when it has one. */
export async function openCustomLogsConfig(): Promise<void> {
  const projectDir = await findCustomLogsProjectDir();
  if (!projectDir) {
    void vscode.window.showInformationMessage(
      localize('customLogs.configure.noWorkspace', 'Open a Salesforce project to configure Custom Logs.')
    );
    return;
  }
  const projectFile = vscode.Uri.file(path.join(projectDir, 'sfdx-project.json'));
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(projectFile);
  } catch {
    void vscode.window.showInformationMessage(
      localize(
        'customLogs.configure.noProjectFile',
        'Custom Logs reads its sources from plugins.electivus.customLogs in sfdx-project.json, which this workspace does not have.'
      )
    );
    return;
  }
  const editor = await vscode.window.showTextDocument(document);
  const offset = findCustomLogsOffset(document.getText());
  if (offset !== undefined) {
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
  }
}
