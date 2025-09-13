import type { WebviewToExtensionMessage } from '../shared/messages';
import { logInfo } from '../utils/logger';

export type TailMessage = Extract<
  WebviewToExtensionMessage,
  {
    type:
      | 'ready'
      | 'getOrgs'
      | 'selectOrg'
      | 'openLog'
      | 'replay'
      | 'tailStart'
      | 'tailStop'
      | 'tailClear';
  }
>;

export class TailMessageHandler {
  constructor(
    private readonly onReady: () => Promise<void>,
    private readonly onGetOrgs: () => Promise<void>,
    private readonly onSelectOrg: (org: string) => Promise<void>,
    private readonly openLog: (logId: string) => Promise<void>,
    private readonly replayLog: (logId: string) => Promise<void>,
    private readonly startTail: (debugLevel?: string) => Promise<void>,
    private readonly stopTail: () => void,
    private readonly clearTail: () => void
  ) {}

  async handle(message: TailMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        logInfo('Tail: message ready');
        await this.onReady();
        break;
      case 'getOrgs':
        logInfo('Tail: message getOrgs');
        await this.onGetOrgs();
        break;
      case 'selectOrg':
        logInfo('Tail: message selectOrg', message.target);
        await this.onSelectOrg(message.target);
        break;
      case 'openLog':
        logInfo('Tail: message openLog', message.logId);
        await this.openLog(message.logId);
        break;
      case 'replay':
        logInfo('Tail: message replay', message.logId);
        await this.replayLog(message.logId);
        break;
      case 'tailStart':
        logInfo('Tail: message tailStart');
        await this.startTail(message.debugLevel);
        break;
      case 'tailStop':
        logInfo('Tail: message tailStop');
        this.stopTail();
        break;
      case 'tailClear':
        logInfo('Tail: message tailClear');
        this.clearTail();
        break;
      default: {
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
      }
    }
  }
}
