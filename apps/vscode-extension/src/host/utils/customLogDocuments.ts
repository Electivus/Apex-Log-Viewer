import * as vscode from 'vscode';
import { reindentJson, type CustomLogTextFormat } from './customLogText';
import { trimOldest } from './trimOldest';

/** Read-only documents for custom-log long text. Closing one never asks to save, because no file backs it. */
export const CUSTOM_LOG_DOCUMENT_SCHEME = 'electivus-custom-log';

const MAX_OPEN_DOCUMENTS = 50;
const MAX_FILE_NAME_LENGTH = 80;

export interface CustomLogDocument {
  /** What the editor tab shows, without an extension. */
  name: string;
  text: string;
  format: CustomLogTextFormat;
}

const UNSAFE_FILE_NAME_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]+/g;

function fileNameOf(name: string, format: CustomLogTextFormat): string {
  const safe = name.replace(UNSAFE_FILE_NAME_CHARACTERS, '_').replace(/\s+/g, ' ').trim();
  return `${safe.slice(0, MAX_FILE_NAME_LENGTH) || 'Custom log'}.${format === 'json' ? 'json' : 'txt'}`;
}

class CustomLogDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private sequence = 0;

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(CUSTOM_LOG_DOCUMENT_SCHEME, this),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === CUSTOM_LOG_DOCUMENT_SCHEME) {
          this.contents.delete(document.uri.toString());
        }
      })
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  async open(document: CustomLogDocument): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: CUSTOM_LOG_DOCUMENT_SCHEME,
      path: `/${fileNameOf(document.name, document.format)}`,
      query: String((this.sequence += 1))
    });
    this.contents.set(uri.toString(), document.format === 'json' ? reindentJson(document.text) : document.text);
    trimOldest(this.contents, MAX_OPEN_DOCUMENTS);
    const opened = await vscode.workspace.openTextDocument(uri);
    const languageId = document.format === 'json' ? 'json' : 'plaintext';
    const shown =
      opened.languageId === languageId ? opened : await vscode.languages.setTextDocumentLanguage(opened, languageId);
    await vscode.window.showTextDocument(shown, { preview: true });
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.contents.clear();
  }
}

let registered: CustomLogDocuments | undefined;

export function registerCustomLogDocuments(context: vscode.ExtensionContext): void {
  registered?.dispose();
  registered = new CustomLogDocuments();
  context.subscriptions.push(registered);
}

export async function openCustomLogDocument(document: CustomLogDocument): Promise<void> {
  if (!registered) {
    throw new Error('Custom log documents are not registered.');
  }
  await registered.open(document);
}
