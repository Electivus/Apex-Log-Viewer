import * as vscode from 'vscode';

/**
 * Build consistent HTML for our webviews with a CSP and shared styling.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptFile: string,
  title: string
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', scriptFile));
  // Allow service/worker scripts from the webview source. VS Code registers
  // an internal service worker to serve local resources. Without an explicit
  // worker-src, the default-src ('none') can cause registration to fail on
  // some platforms, leading to sporadic "Could not register service worker"
  // errors. Keeping other directives tight.
  const csp = `default-src 'none'; img-src ${webview.cspSource} https:; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; worker-src ${webview.cspSource};`;
  return `<!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        :root { color-scheme: light dark; }
        body { color: var(--vscode-foreground); background: transparent; }
        select {
          background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
          color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
          border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
          outline-color: var(--vscode-focusBorder);
        }
        option {
          background-color: var(--vscode-dropdown-background, var(--vscode-input-background));
          color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
        }
        option:checked, option:hover {
          background-color: var(--vscode-list-activeSelectionBackground, var(--vscode-dropdown-background));
          color: var(--vscode-list-activeSelectionForeground, var(--vscode-dropdown-foreground));
        }
      </style>
      <title>${title}</title>
      </head>
      <body>
      <div id="root"></div>
      <script src="${scriptUri}"></script>
      </body>
      </html>`;
}
