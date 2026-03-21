import * as vscode from 'vscode';

/**
 * Build consistent HTML for our webviews with a CSP and shared styling.
 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptFile: string,
  title: string,
  options?: {
    rootData?: Record<string, string | undefined>;
  }
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', scriptFile));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
  const rootDataAttributes = Object.entries(options?.rootData ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([key, value]) => ` data-${key}="${escapeHtmlAttribute(value)}"`)
    .join('');
  // Allow service/worker scripts and fetches against the webview source. VS Code
  // registers an internal service worker to serve local resources. Without an
  // explicit worker-src and connect-src, the default-src ('none') can cause
  // registration or fetches (including log downloads) to fail on some
  // platforms, leading to sporadic "Could not register service worker" errors
  // or blocked network requests. Keeping other directives tight.
  const csp = `default-src 'none'; img-src ${webview.cspSource} https:; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; connect-src ${webview.cspSource}; worker-src ${webview.cspSource};`;
  return `<!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="${styleUri}">
      <title>${title}</title>
      </head>
      <body>
      <div id="root"${rootDataAttributes}></div>
      <script src="${scriptUri}"></script>
      </body>
      </html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
