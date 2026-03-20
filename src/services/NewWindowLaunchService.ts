import { LAUNCH_REQUEST_TTL_MS, isPendingLaunchRequest, type PendingLaunchRequest, type OpenInNewWindowHandlers, type LaunchContextProvider } from '../shared/newWindowLaunch';
import { getCurrentWorkspaceTarget, workspaceTargetsEqual } from '../utils/workspace';

const PENDING_LAUNCH_KEY = 'pendingNewWindowLaunch';

export class NewWindowLaunchService {
  constructor(private readonly context: LaunchContextProvider) {}

  async consumePendingLaunch(handlers: OpenInNewWindowHandlers): Promise<void> {
    const raw = this.context.globalState.get(PENDING_LAUNCH_KEY);
    const request = await this.normalizeRequest(raw);
    if (!request) {
      return;
    }

    const currentWorkspaceTarget = getCurrentWorkspaceTarget();
    if (!workspaceTargetsEqual(request.workspaceTarget, currentWorkspaceTarget)) {
      await this.clearPendingLaunch();
      return;
    }

    await this.clearPendingLaunch();

    await handlers.restoreWindowContext({ selectedOrg: request.selectedOrg });
    switch (request.kind) {
      case 'logs':
        await handlers.openLogs({ selectedOrg: request.selectedOrg });
        return;
      case 'tail':
        await handlers.openTail({ selectedOrg: request.selectedOrg });
        return;
      case 'debugFlags':
        await handlers.openDebugFlags({ selectedOrg: request.selectedOrg });
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

  private async clearPendingLaunch(): Promise<void> {
    await this.context.globalState.update(PENDING_LAUNCH_KEY, undefined);
  }

  private async normalizeRequest(value: unknown): Promise<PendingLaunchRequest | undefined> {
    if (!isPendingLaunchRequest(value)) {
      await this.clearPendingLaunch();
      return undefined;
    }

    if (Date.now() - value.createdAt > LAUNCH_REQUEST_TTL_MS) {
      await this.clearPendingLaunch();
      return undefined;
    }

    if (value.kind === 'logViewer' && (!value.logId || !value.filePath)) {
      await this.clearPendingLaunch();
      return undefined;
    }

    return value;
  }
}
