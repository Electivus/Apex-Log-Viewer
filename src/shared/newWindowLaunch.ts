import * as os from 'node:os';
import * as path from 'node:path';

export const LAUNCH_REQUEST_TTL_MS = 60_000;

export type WorkspaceTarget =
  | {
      type: 'workspaceFile';
      uri: string;
    }
  | {
      type: 'folder';
      uri: string;
    };

export type NewWindowLaunchSourceView = 'logs' | 'tail';

export type PendingLaunchKind = 'logs' | 'tail' | 'debugFlags' | 'logViewer';

type PendingLaunchBase = {
  version: 1;
  workspaceTarget: WorkspaceTarget;
  kind: Exclude<PendingLaunchKind, 'logViewer'>;
  selectedOrg?: string;
  sourceView?: NewWindowLaunchSourceView;
  createdAt: number;
  nonce: string;
};

type PendingLaunchLogViewer = {
  version: 1;
  workspaceTarget: WorkspaceTarget;
  kind: 'logViewer';
  selectedOrg?: string;
  sourceView?: NewWindowLaunchSourceView;
  logId: string;
  filePath: string;
  createdAt: number;
  nonce: string;
};

export type PendingLaunchRequest = PendingLaunchBase | PendingLaunchLogViewer;
export type PendingLaunchLogViewerRequest = PendingLaunchLogViewer;

export interface LaunchContextProvider {
  globalState: {
    get(key: string): unknown;
    update(key: string, value: unknown): Promise<void> | Thenable<void> | void;
  };
  openFolder?: (
    workspaceTarget: WorkspaceTarget,
    options?: {
      filesToOpen?: string[];
    }
  ) => Promise<void> | Thenable<void> | void;
  waitForLaunchMarker?: (nonce: string) => Promise<boolean> | Thenable<boolean> | boolean;
  clearLaunchMarker?: (nonce: string) => Promise<void> | Thenable<void> | void;
}

export type OpenInNewWindowHandlers = {
  restoreWindowContext: (request: Pick<PendingLaunchRequest, 'selectedOrg'>) => Promise<void> | void;
  openLogs: (request: Pick<PendingLaunchRequest, 'selectedOrg'>) => Promise<void> | void;
  openTail: (request: Pick<PendingLaunchRequest, 'selectedOrg'>) => Promise<void> | void;
  openDebugFlags: (
    request: Pick<PendingLaunchRequest, 'selectedOrg' | 'sourceView'>
  ) => Promise<void> | void;
  openLogViewer: (
    request: Pick<PendingLaunchLogViewerRequest, 'selectedOrg' | 'logId' | 'filePath'>
  ) => Promise<void> | void;
};

export function isWorkspaceTarget(value: unknown): value is WorkspaceTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { type?: unknown; uri?: unknown };
  if (candidate.type !== 'workspaceFile' && candidate.type !== 'folder') {
    return false;
  }
  return typeof candidate.uri === 'string' && candidate.uri.length > 0;
}

export function isValidPendingLaunchKind(value: unknown): value is PendingLaunchKind {
  return value === 'logs' || value === 'tail' || value === 'debugFlags' || value === 'logViewer';
}

export function isPendingLaunchRequest(value: unknown): value is PendingLaunchRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PendingLaunchRequest>;
  if (candidate.version !== 1 || !isValidPendingLaunchKind(candidate.kind)) {
    return false;
  }
  if (!isWorkspaceTarget(candidate.workspaceTarget)) {
    return false;
  }
  if (typeof candidate.createdAt !== 'number' || !Number.isFinite(candidate.createdAt) || candidate.createdAt <= 0) {
    return false;
  }
  if (typeof candidate.nonce !== 'string' || candidate.nonce.length === 0) {
    return false;
  }
  if (candidate.selectedOrg !== undefined && typeof candidate.selectedOrg !== 'string') {
    return false;
  }
  if (candidate.sourceView !== undefined && candidate.sourceView !== 'logs' && candidate.sourceView !== 'tail') {
    return false;
  }

  if (candidate.kind === 'logViewer') {
    return typeof candidate.logId === 'string' && candidate.logId.length > 0 && typeof candidate.filePath === 'string' && candidate.filePath.length > 0;
  }

  return true;
}

export function getPendingLaunchMarkerPath(nonce: string): string {
  const safeNonce = nonce.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `apex-log-viewer-new-window-${safeNonce}.tmp`);
}
