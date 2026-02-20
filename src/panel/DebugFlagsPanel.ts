import * as vscode from 'vscode';
import { getOrgAuth, listOrgs } from '../salesforce/cli';
import {
  getActiveUserDebugLevel,
  getUserTraceFlagStatus,
  listActiveUsers,
  listDebugLevels,
  removeUserTraceFlags,
  upsertUserTraceFlag
} from '../salesforce/traceflags';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '../shared/debugFlagsMessages';
import { safeSendEvent } from '../shared/telemetry';
import { pickSelectedOrg } from '../utils/orgs';
import { localize } from '../utils/localize';
import { getErrorMessage } from '../utils/error';
import { logInfo, logWarn } from '../utils/logger';
import { buildWebviewHtml } from '../utils/webviewHtml';

interface ShowOptions {
  selectedOrg?: string;
  sourceView?: 'logs' | 'tail';
}

export class DebugFlagsPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static instance: DebugFlagsPanel | undefined;
  private static readonly viewType = 'sfLogViewer.debugFlagsPanel';

  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  static async show(options?: ShowOptions): Promise<void> {
    const extensionUri = this.context?.extensionUri;
    if (!extensionUri) {
      void vscode.window.showWarningMessage(
        localize('debugFlags.unavailable', 'Debug Flags panel is unavailable before extension activation.')
      );
      return;
    }

    if (this.instance) {
      this.instance.reveal();
      if (options?.sourceView) {
        this.instance.lastSourceView = options.sourceView;
      }
      if (typeof options?.selectedOrg === 'string') {
        await this.instance.setSelectedOrg(options.selectedOrg);
      }
      return;
    }

    this.instance = new DebugFlagsPanel(extensionUri, options);
  }

  private readonly panel: vscode.WebviewPanel;
  private selectedOrg: string | undefined;
  private selectedUserId: string | undefined;
  private usersQuery = '';
  private disposed = false;
  private usersToken = 0;
  private statusToken = 0;
  private orgBootstrapToken = 0;
  private lastSourceView: 'logs' | 'tail' | 'unknown' = 'unknown';

  private constructor(extensionUri: vscode.Uri, options?: ShowOptions) {
    this.selectedOrg = typeof options?.selectedOrg === 'string' ? options.selectedOrg.trim() || undefined : undefined;
    this.lastSourceView = options?.sourceView ?? 'unknown';

    this.panel = vscode.window.createWebviewPanel(
      DebugFlagsPanel.viewType,
      localize('debugFlags.panel.title', 'Apex Debug Flags'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    this.panel.webview.html = buildWebviewHtml(
      this.panel.webview,
      extensionUri,
      'debugFlags.js',
      localize('debugFlags.panel.title', 'Apex Debug Flags')
    );

    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message as DebugFlagsFromWebviewMessage));
    DebugFlagsPanel.context?.subscriptions.push(this.panel);
  }

  private reveal(): void {
    this.panel.reveal(undefined, true);
  }

  private async setSelectedOrg(nextOrg: string): Promise<void> {
    const normalized = nextOrg.trim() || undefined;
    if (this.selectedOrg === normalized) {
      return;
    }
    this.selectedOrg = normalized;
    this.selectedUserId = undefined;
    await this.bootstrapData();
  }

  private post(message: DebugFlagsToWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: DebugFlagsFromWebviewMessage): Promise<void> {
    if (!message?.type || this.disposed) {
      return;
    }

    switch (message.type) {
      case 'debugFlagsReady':
        this.post({ type: 'debugFlagsInit', locale: vscode.env.language, defaultTtlMinutes: 30 });
        await this.bootstrapData();
        break;
      case 'debugFlagsSelectOrg':
        await this.setSelectedOrg(typeof message.target === 'string' ? message.target : '');
        break;
      case 'debugFlagsSearchUsers':
        this.usersQuery = typeof message.query === 'string' ? message.query : '';
        await this.searchUsers();
        break;
      case 'debugFlagsSelectUser':
        if (!message.userId) {
          return;
        }
        this.selectedUserId = message.userId;
        await this.loadSelectedUserStatus(message.userId);
        break;
      case 'debugFlagsApply':
        await this.applyUserTraceFlag(message.userId, message.debugLevelName, message.ttlMinutes);
        break;
      case 'debugFlagsRemove':
        await this.removeUserTraceFlag(message.userId);
        break;
    }
  }

  private async bootstrapData(): Promise<void> {
    const token = ++this.orgBootstrapToken;
    this.post({ type: 'debugFlagsLoading', scope: 'orgs', value: true });
    try {
      const orgs = await listOrgs();
      if (token !== this.orgBootstrapToken || this.disposed) {
        return;
      }

      this.selectedOrg = pickSelectedOrg(orgs, this.selectedOrg);
      this.post({
        type: 'debugFlagsOrgs',
        data: orgs,
        selected: this.selectedOrg
      });

      const auth = await this.getSelectedAuth();
      if (token !== this.orgBootstrapToken || this.disposed) {
        return;
      }

      const [levels, active] = await Promise.all([
        listDebugLevels(auth).catch(err => {
          logWarn('DebugFlagsPanel: failed to load debug levels ->', getErrorMessage(err));
          return [] as string[];
        }),
        getActiveUserDebugLevel(auth).catch(() => undefined as string | undefined)
      ]);
      if (token !== this.orgBootstrapToken || this.disposed) {
        return;
      }
      const output = [...levels];
      if (active && !output.includes(active)) {
        output.unshift(active);
      }
      this.post({
        type: 'debugFlagsDebugLevels',
        data: output,
        active
      });
      await this.searchUsers();
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: bootstrap failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.loadOrgsFailed', 'Failed to load org and debug level data: {0}', msg)
      });
    } finally {
      if (token === this.orgBootstrapToken) {
        this.post({ type: 'debugFlagsLoading', scope: 'orgs', value: false });
      }
    }
  }

  private async searchUsers(): Promise<void> {
    const token = ++this.usersToken;
    this.post({ type: 'debugFlagsLoading', scope: 'users', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const users = await listActiveUsers(auth, this.usersQuery, 50);
      if (token !== this.usersToken || this.disposed) {
        return;
      }
      this.post({ type: 'debugFlagsUsers', query: this.usersQuery, data: users });
      if (this.selectedUserId && !users.some(user => user.id === this.selectedUserId)) {
        const previous = this.selectedUserId;
        this.selectedUserId = undefined;
        this.post({ type: 'debugFlagsUserStatus', userId: previous, status: undefined });
      }
    } catch (e) {
      if (token !== this.usersToken || this.disposed) {
        return;
      }
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: user search failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.loadUsersFailed', 'Failed to load users: {0}', msg)
      });
    } finally {
      if (token === this.usersToken && !this.disposed) {
        this.post({ type: 'debugFlagsLoading', scope: 'users', value: false });
      }
    }
  }

  private async loadSelectedUserStatus(userId: string): Promise<void> {
    if (!userId) {
      return;
    }
    const token = ++this.statusToken;
    this.post({ type: 'debugFlagsLoading', scope: 'status', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const status = await getUserTraceFlagStatus(auth, userId);
      if (token !== this.statusToken || this.disposed) {
        return;
      }
      this.post({
        type: 'debugFlagsUserStatus',
        userId,
        status
      });
    } catch (e) {
      if (token !== this.statusToken || this.disposed) {
        return;
      }
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: failed loading user status ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.loadStatusFailed', 'Failed to load debug flag status: {0}', msg)
      });
    } finally {
      if (token === this.statusToken && !this.disposed) {
        this.post({ type: 'debugFlagsLoading', scope: 'status', value: false });
      }
    }
  }

  private async applyUserTraceFlag(userId: string, debugLevelName: string, ttlMinutes: number): Promise<void> {
    if (!userId) {
      return;
    }
    const t0 = Date.now();
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const result = await upsertUserTraceFlag(auth, {
        userId,
        debugLevelName,
        ttlMinutes
      });
      await this.loadSelectedUserStatus(userId);
      this.post({
        type: 'debugFlagsNotice',
        tone: 'success',
        message: result.created
          ? localize('debugFlags.applyCreated', 'Debug flag created successfully.')
          : localize('debugFlags.applyUpdated', 'Debug flag updated successfully.')
      });
      safeSendEvent(
        'debugFlags.apply',
        {
          outcome: 'ok',
          sourceView: this.lastSourceView
        },
        { durationMs: Date.now() - t0 }
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: apply failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.applyFailed', 'Failed to apply debug flag: {0}', msg)
      });
      safeSendEvent(
        'debugFlags.apply',
        {
          outcome: 'error',
          sourceView: this.lastSourceView
        },
        { durationMs: Date.now() - t0 }
      );
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private async removeUserTraceFlag(userId: string): Promise<void> {
    if (!userId) {
      return;
    }
    const t0 = Date.now();
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const removed = await removeUserTraceFlags(auth, userId);
      await this.loadSelectedUserStatus(userId);
      this.post({
        type: 'debugFlagsNotice',
        tone: removed > 0 ? 'success' : 'info',
        message:
          removed > 0
            ? localize('debugFlags.removeSuccess', 'Debug flag removed successfully.')
            : localize('debugFlags.removeNone', 'No active USER_DEBUG trace flag was found for this user.')
      });
      safeSendEvent(
        'debugFlags.remove',
        {
          outcome: 'ok',
          sourceView: this.lastSourceView
        },
        { durationMs: Date.now() - t0, removedCount: removed }
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: remove failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.removeFailed', 'Failed to remove debug flag: {0}', msg)
      });
      safeSendEvent(
        'debugFlags.remove',
        {
          outcome: 'error',
          sourceView: this.lastSourceView
        },
        { durationMs: Date.now() - t0 }
      );
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private async getSelectedAuth() {
    const selected = (this.selectedOrg || '').trim();
    if (!selected) {
      throw new Error(localize('debugFlags.noOrg', 'No Salesforce org is selected.'));
    }
    return getOrgAuth(selected);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    logInfo('DebugFlagsPanel: disposed.');
    if (DebugFlagsPanel.instance === this) {
      DebugFlagsPanel.instance = undefined;
    }
  }
}
