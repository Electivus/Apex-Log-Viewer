import { promises as fs } from 'node:fs';
import {
  LAUNCH_REQUEST_TTL_MS,
  getPendingLaunchMarkerPath,
  isPendingLaunchRequest,
  type PendingLaunchRequest,
  type OpenInNewWindowHandlers,
  type LaunchContextProvider
} from '../shared/newWindowLaunch';
import type { WorkspaceTarget } from '../shared/newWindowLaunch';
import { getCurrentWorkspaceTarget, workspaceTargetsEqual } from '../utils/workspace';

const PENDING_LAUNCH_KEY = 'pendingNewWindowLaunch';

export class NewWindowLaunchService {
  constructor(private readonly context: LaunchContextProvider) {}

  async launchInNewWindow(
    request: Omit<PendingLaunchRequest, 'version' | 'createdAt' | 'nonce'>
  ): Promise<void> {
    const launchRequest = {
      ...request,
      version: 1,
      createdAt: Date.now(),
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`
    } as PendingLaunchRequest;

    if (!this.isValidWorkspaceTarget(launchRequest.workspaceTarget)) {
      return;
    }

    await this.ensureLaunchMarker(launchRequest.nonce);
    await this.context.globalState.update(PENDING_LAUNCH_KEY, launchRequest);
    try {
      await this.context.openFolder?.(launchRequest.workspaceTarget, {
        filesToOpen: [getPendingLaunchMarkerPath(launchRequest.nonce)]
      });
    } catch (error) {
      await this.clearPendingLaunch(launchRequest);
      throw error;
    }
  }

  private isValidWorkspaceTarget(value: unknown): value is WorkspaceTarget {
    return (
      Boolean(value && typeof value === 'object') &&
      ((value as { type?: unknown }).type === 'folder' || (value as { type?: unknown }).type === 'workspaceFile') &&
      typeof (value as { uri?: unknown }).uri === 'string' &&
      (value as { uri: string }).uri.length > 0
    );
  }

  async consumePendingLaunch(handlers: OpenInNewWindowHandlers): Promise<void> {
    const raw = this.context.globalState.get(PENDING_LAUNCH_KEY);
    const request = await this.normalizeRequest(raw);
    if (!request) {
      return;
    }

    const currentWorkspaceTarget = getCurrentWorkspaceTarget();
    if (!workspaceTargetsEqual(request.workspaceTarget, currentWorkspaceTarget)) {
      return;
    }

    if (this.context.waitForLaunchMarker && !(await this.context.waitForLaunchMarker(request.nonce))) {
      return;
    }

    await this.clearPendingLaunch(request);

    await handlers.restoreWindowContext({ selectedOrg: request.selectedOrg });
    switch (request.kind) {
      case 'logs':
        await handlers.openLogs({ selectedOrg: request.selectedOrg });
        return;
      case 'tail':
        await handlers.openTail({ selectedOrg: request.selectedOrg });
        return;
      case 'debugFlags':
        await handlers.openDebugFlags({ selectedOrg: request.selectedOrg, sourceView: request.sourceView });
        return;
      case 'logViewer':
        await handlers.openLogViewer({
          logId: request.logId,
          filePath: request.filePath,
          selectedOrg: request.selectedOrg
        });
        return;
    }
  }

  private async clearPendingLaunch(request?: PendingLaunchRequest): Promise<void> {
    await this.context.globalState.update(PENDING_LAUNCH_KEY, undefined);
    if (request) {
      await this.context.clearLaunchMarker?.(request.nonce);
    }
  }

  private async normalizeRequest(value: unknown): Promise<PendingLaunchRequest | undefined> {
    if (!isPendingLaunchRequest(value)) {
      if (value !== undefined) {
        await this.clearPendingLaunch();
      }
      return undefined;
    }

    if (Date.now() - value.createdAt > LAUNCH_REQUEST_TTL_MS) {
      await this.clearPendingLaunch(value);
      return undefined;
    }

    if (value.kind === 'logViewer' && (!value.logId || !value.filePath)) {
      await this.clearPendingLaunch(value);
      return undefined;
    }

    return value;
  }

  private async ensureLaunchMarker(nonce: string): Promise<void> {
    await fs.writeFile(getPendingLaunchMarkerPath(nonce), '', 'utf8');
  }
}
