import type { LogGraph } from './apexLogParser';

// Messages sent from Webview -> Extension (diagram panel)
export type DiagramWebviewToExtensionMessage = { type: 'ready' };

// Messages sent from Extension -> Webview (diagram panel)
export type DiagramExtensionToWebviewMessage = { type: 'graph'; graph: LogGraph };

