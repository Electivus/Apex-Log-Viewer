import * as vscode from 'vscode';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../shared/messages';
import { logInfo } from '../utils/logger';

export class TailMessageHandler {
  constructor(
    private readonly sendOrgs: () => Promise<void>,
    private readonly sendDebugLevels: () => Promise<void>,
    private readonly setSelectedOrg: (org?: string) => void,
    private readonly getSelectedOrg: () => string | undefined,
    private readonly setTailOrg: (org?: string) => void,
    private readonly stopTail: () => void,
    private readonly startTail: (debugLevel?: string) => Promise<void>,
    private readonly clearTail: () => void,
    private readonly isTailRunning: () => boolean,
    private readonly openLog: (logId: string) => Promise<void>,
    private readonly replayLog: (logId: string) => Promise<void>,
    private readonly getTailBufferSize: () => number,
    private readonly post: (msg: ExtensionToWebviewMessage) => void,
    private readonly setLoading: (val: boolean) => void
  ) {}

  async handle(message: WebviewToExtensionMessage): Promise<void> {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case 'ready':
        logInfo('Tail: message ready');
        this.setLoading(true);
        await this.sendOrgs();
        await this.sendDebugLevels();
        this.post({ type: 'init', locale: vscode.env.language });
        this.post({ type: 'tailConfig', tailBufferSize: this.getTailBufferSize() });
        this.post({ type: 'tailStatus', running: this.isTailRunning() });
        this.setLoading(false);
        break;
      case 'getOrgs':
        logInfo('Tail: message getOrgs');
        this.setLoading(true);
        try {
          await this.sendOrgs();
          await this.sendDebugLevels();
        } finally {
          this.setLoading(false);
        }
        break;
      case 'selectOrg':
        logInfo('Tail: message selectOrg');
        const next = typeof message.target === 'string' ? message.target.trim() || undefined : undefined;
        const prev = this.getSelectedOrg();
        this.setSelectedOrg(next);
        this.setTailOrg(next);
        if (prev !== next) {
          this.stopTail();
        }
        this.setLoading(true);
        try {
          await this.sendOrgs();
          await this.sendDebugLevels();
        } finally {
          this.setLoading(false);
        }
        break;
      case 'openLog':
        if (message.logId) {
          logInfo('Tail: openLog', message.logId);
          await this.openLog(message.logId);
        }
        break;
      case 'replay':
        if (message.logId) {
          logInfo('Tail: replay', message.logId);
          await this.replayLog(message.logId);
        }
        break;
      case 'tailStart':
        logInfo('Tail: tailStart');
        this.setLoading(true);
        try {
          await this.startTail(
            typeof message.debugLevel === 'string' ? message.debugLevel.trim() : undefined
          );
        } finally {
          this.setLoading(false);
        }
        break;
      case 'tailStop':
        logInfo('Tail: tailStop');
        this.stopTail();
        break;
      case 'tailClear':
        logInfo('Tail: tailClear');
        this.clearTail();
        this.post({ type: 'tailReset' });
        break;
    }
  }
}
