import type { LogEntry } from '../../../../src/utils/logger';
import type { WebviewLifecycleEvent, WebviewProviderDiagnosticState } from './webviewDiagnostics';

export interface DiagnosticsPackage {
  generatedAt: string;
  extension: {
    name: string;
    version: string;
  };
  vscode: {
    version: string;
    appName?: string;
    appHost?: string;
    appRoot?: string;
    language?: string;
    remoteName?: string;
    uiKind?: string | number;
  };
  process: {
    platform: string;
    arch: string;
    versions: {
      node?: string;
      electron?: string;
      chrome?: string;
      v8?: string;
    };
  };
  workspace: {
    hasWorkspace: boolean;
    workspaceFolderCount: number;
    workspaceFolders: string[];
    hasSalesforceProject: boolean;
    salesforceProjectRoot?: string;
    salesforceProjectFile?: string;
    sourceApiVersion?: string;
  };
  webview: {
    retainContextWhenHidden: boolean;
    stableVisibilityDelayMs: number;
    readyTimeoutMs: number;
    providers: WebviewProviderDiagnosticState[];
    events: WebviewLifecycleEvent[];
  };
  recentLogs: LogEntry[];
}

export function formatDiagnosticsPackageMarkdown(pkg: DiagnosticsPackage): string {
  const providers = pkg.webview.providers
    .map(provider => {
      const host = provider.hostKind ? `${provider.hostKind}, visible=${String(provider.visible)}` : 'unresolved';
      return `- ${provider.surface}: ready=${provider.ready}, mounted=${provider.contentMounted}, host=${host}, mountSequence=${provider.mountSequence}`;
    })
    .join('\n');

  const recentEvents = pkg.webview.events
    .slice(-20)
    .map(event => {
      const host = event.hostKind ? ` ${event.hostKind}` : '';
      const sequence = event.mountSequence === undefined ? '' : ` #${event.mountSequence}`;
      return `- ${event.timestamp} ${event.surface}${host}${sequence}: ${event.event}`;
    })
    .join('\n');

  return [
    '# Electivus Apex Logs Diagnostics',
    '',
    `Generated: ${pkg.generatedAt}`,
    `VS Code: ${pkg.vscode.version} (${pkg.vscode.appHost ?? 'unknown host'})`,
    `Platform: ${pkg.process.platform}/${pkg.process.arch}, Node ${pkg.process.versions.node ?? 'unknown'}`,
    `Workspace folders: ${pkg.workspace.workspaceFolderCount}`,
    `Salesforce project detected: ${pkg.workspace.hasSalesforceProject}`,
    '',
    '## Webview State',
    providers || '- No providers recorded.',
    '',
    '## Recent Webview Events',
    recentEvents || '- No webview lifecycle events recorded.',
    '',
    '## JSON',
    '```json',
    JSON.stringify(pkg, null, 2),
    '```'
  ].join('\n');
}
