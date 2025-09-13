import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo } from '../utils/logger';

export class TailMessageHandler {
  constructor(
    private readonly sendOrgs: () => Promise<void>,
    private readonly sendDebugLevels: () => Promise<void>,
    private readonly openLog: (logId: string) => Promise<void>,
    private readonly replayLog: (logId: string) => Promise<void>,
    private readonly setSelectedOrg: (org?: string) => void,
    private readonly getSelectedOrg: () => string | undefined,
    private readonly setTailOrg: (org?: string) => void,
    private readonly startTail: (debugLevel?: string) => Promise<void>,
    private readonly stopTail: () => void,
    private readonly clearTail: () => void,
    private readonly isTailRunning: () => boolean,
    private readonly getTailBufferSize: () => number,
    private readonly post: (msg: ExtensionToWebviewMessage) => void,
    private readonly setLoading: (val: boolean) => void
  ) {}

  async handle(message: WebviewToExtensionMessage): Promise<void> {
    if (!message?.type) {
      return;
    }
    logInfo('Tail: message', message.type);
    switch (message.type) {
      case 'ready':
        this.setLoading(true);
        await this.sendOrgs();
        await this.sendDebugLevels();
        this.post({ type: 'init', locale: vscode.env.language });
        this.post({ type: 'tailConfig', tailBufferSize: this.getTailBufferSize() });
        this.post({ type: 'tailStatus', running: this.isTailRunning() });
        this.setLoading(false);
        break;
      case 'getOrgs':
        this.setLoading(true);
        try {
          await this.sendOrgs();
          await this.sendDebugLevels();
        } finally {
          this.setLoading(false);
        }
        break;
      case 'selectOrg':
        {
          const target = typeof message.target === 'string' ? message.target.trim() : undefined;
          const next = target || undefined;
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
        }
        break;
      case 'openLog':
        if (message.logId) {
          await this.openLog(message.logId);
        }
        break;
      case 'replay':
        if (message.logId) {
          await this.replayLog(message.logId);
        }
        break;
      case 'tailStart':
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
        this.stopTail();
        break;
      case 'tailClear':
        this.clearTail();
        this.post({ type: 'tailReset' });
        break;
    }
  }
}

