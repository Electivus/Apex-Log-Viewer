import * as vscode from 'vscode';

/** VS Code may prefix webview tab types even though the API describes the panel's view type. */
const REPORTED_WEBVIEW_TAB_PREFIX = /^mainThreadWebview-/;

export function isWebviewTab({ input }: vscode.Tab, viewTypes: ReadonlySet<string>): boolean {
  return (
    input instanceof vscode.TabInputWebview && viewTypes.has(input.viewType.replace(REPORTED_WEBVIEW_TAB_PREFIX, ''))
  );
}

/** Scans the tab groups because a tab can outlive the extension host whose panel tracked it. */
export function closeTabs(matches: (tab: vscode.Tab) => boolean): void {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(matches);
  if (tabs.length > 0) {
    void vscode.window.tabGroups.close(tabs);
  }
}
