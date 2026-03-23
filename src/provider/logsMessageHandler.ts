import type { WebviewToExtensionMessage } from '../shared/messages';
import { safeSendEvent } from '../shared/telemetry';
import { logInfo } from '../utils/logger';

export class LogsMessageHandler {
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly downloadAllLogs: () => Promise<void>,
    private readonly clearLogs: (scope: 'all' | 'mine') => Promise<void>,
    private readonly sendOrgs: () => Promise<void>,
    private readonly setSelectedOrg: (org?: string) => void,
    private readonly openDebugFlags: () => Promise<void>,
    private readonly openLog: (logId: string) => Promise<void>,
    private readonly debugLog: (logId: string) => Promise<void>,
    private readonly loadMore: () => Promise<void>,
    private readonly setLoading: (val: boolean) => void,
    private readonly setSearchQuery: (value: string) => Promise<void>,
    private readonly setLogsColumns: (value: unknown) => Promise<void>
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
      case 'downloadAllLogs':
        logInfo('Logs: downloadAllLogs');
        await this.downloadAllLogs();
        break;
      case 'clearLogs':
        logInfo('Logs: clearLogs', (message as any)?.scope);
        await this.clearLogs(message.scope === 'mine' ? 'mine' : 'all');
        break;
      case 'selectOrg':
        this.setSelectedOrg(typeof message.target === 'string' ? message.target.trim() : undefined);
        logInfo('Logs: selected org set');
        await this.refresh();
        break;
      case 'openDebugFlags':
        logInfo('Logs: openDebugFlags');
        await this.openDebugFlags();
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
      case 'searchQuery':
        await this.setSearchQuery(typeof message.value === 'string' ? message.value : '');
        break;
      case 'trackLogsSearch':
        safeSendEvent(
          'logs.search',
          message.outcome === 'searched' && message.queryLength
            ? { outcome: message.outcome, queryLength: message.queryLength }
            : { outcome: message.outcome }
        );
        break;
      case 'trackLogsFilter':
        safeSendEvent(
          'logs.filter',
          {
            outcome: message.outcome,
            hasUser: String(message.hasUser),
            hasOperation: String(message.hasOperation),
            hasStatus: String(message.hasStatus),
            hasCodeUnit: String(message.hasCodeUnit),
            errorsOnly: String(message.errorsOnly)
          },
          { activeCount: message.activeCount }
        );
        break;
      case 'setLogsColumns':
        await this.setLogsColumns(message.value);
        break;
    }
  }
}
