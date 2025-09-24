import type { WebviewToExtensionMessage } from '../shared/messages';
import { logInfo } from '../utils/logger';

export class LogsMessageHandler {
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly sendOrgs: () => Promise<void>,
    private readonly setSelectedOrg: (org?: string) => void,
    private readonly setPrefetchLogBodies: (enabled: boolean) => Promise<void>,
    private readonly openLog: (logId: string) => Promise<void>,
    private readonly debugLog: (logId: string) => Promise<void>,
    private readonly loadMore: () => Promise<void>,
    private readonly setLoading: (val: boolean) => void
  ) {}

  async handle(message: WebviewToExtensionMessage): Promise<void> {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case 'ready':
        logInfo('Logs: message ready');
        this.setLoading(true);
        await this.sendOrgs();
        await this.refresh();
        this.setLoading(false);
        break;
      case 'refresh':
        logInfo('Logs: message refresh');
        await this.refresh();
        break;
      case 'selectOrg':
        this.setSelectedOrg(typeof message.target === 'string' ? message.target.trim() : undefined);
        logInfo('Logs: selected org set');
        await this.refresh();
        break;
      case 'setPrefetchLogBodies':
        logInfo('Logs: setPrefetchLogBodies', message.value);
        await this.setPrefetchLogBodies(!!message.value);
        break;
      case 'openLog':
        if (message.logId) {
          logInfo('Logs: openLog', message.logId);
          await this.openLog(message.logId);
        }
        break;
      case 'replay':
        if (message.logId) {
          logInfo('Logs: replay', message.logId);
          await this.debugLog(message.logId);
        }
        break;
      case 'loadMore':
        logInfo('Logs: loadMore');
        await this.loadMore();
        break;
    }
  }
}
