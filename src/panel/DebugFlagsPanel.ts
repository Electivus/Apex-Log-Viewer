import * as vscode from 'vscode';
import { getOrgAuth, listOrgs } from '../salesforce/cli';
import {
  createDebugLevel,
  deleteDebugLevel,
  getActiveUserDebugLevel,
  getTraceFlagTargetStatus,
  listActiveUsers,
  listDebugLevelDetails,
  removeTraceFlags,
  updateDebugLevel,
  upsertTraceFlag
} from '../salesforce/traceflags';
import { DEBUG_LEVEL_PRESETS } from '../shared/debugLevelPresets';
import { clearApexLogs } from '../services/apexLogCleanup';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '../shared/debugFlagsMessages';
import type { DebugLevelRecord, TraceFlagTarget, TraceFlagTargetStatus } from '../shared/debugFlagsTypes';
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
  private selectedTarget: TraceFlagTarget | undefined;
  private usersQuery = '';
  private disposed = false;
  private usersToken = 0;
  private statusToken = 0;
  private orgBootstrapToken = 0;
  private lastSourceView: 'logs' | 'tail' | 'unknown' = 'unknown';
  private clearLogsInProgress = false;

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
    this.selectedTarget = undefined;
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
      case 'debugFlagsSelectTarget':
        if (!message.target) {
          return;
        }
        this.selectedTarget = message.target;
        await this.loadSelectedTargetStatus(message.target);
        break;
      case 'debugFlagsApply':
        await this.applyTraceFlag(message.target, message.debugLevelName, message.ttlMinutes);
        break;
      case 'debugFlagsManagerSave':
        await this.saveDebugLevel(message.draft);
        break;
      case 'debugFlagsManagerDelete':
        await this.removeDebugLevel(message.debugLevelId);
        break;
      case 'debugFlagsRemove':
        await this.removeTraceFlag(message.target);
        break;
      case 'debugFlagsClearLogs':
        await this.clearLogs(message.scope === 'mine' ? 'mine' : 'all');
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

      await this.sendDebugLevelData(auth, undefined, token);
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

  private async sendDebugLevelData(
    auth: Awaited<ReturnType<DebugFlagsPanel['getSelectedAuth']>>,
    selectedId?: string,
    bootstrapToken?: number
  ): Promise<void> {
    const [details, active] = await Promise.all([
      listDebugLevelDetails(auth).catch(err => {
        logWarn('DebugFlagsPanel: failed to load debug level details ->', getErrorMessage(err));
        return [] as DebugLevelRecord[];
      }),
      getActiveUserDebugLevel(auth).catch(() => undefined as string | undefined)
    ]);

    if (
      this.disposed ||
      (typeof bootstrapToken === 'number' && bootstrapToken !== this.orgBootstrapToken)
    ) {
      return;
    }

    const output = details.map(record => record.developerName).filter(Boolean);
    if (active && !output.includes(active)) {
      output.unshift(active);
    }
    this.post({
      type: 'debugFlagsDebugLevels',
      data: output,
      active
    });

    const preferredId =
      selectedId && details.some(record => record.id === selectedId)
        ? selectedId
        : details[0]?.id;

    this.post({
      type: 'debugFlagsManagerData',
      records: details,
      presets: DEBUG_LEVEL_PRESETS,
      selectedId: preferredId
    });
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
      const selectedUserTarget = this.selectedTarget?.type === 'user' ? this.selectedTarget : undefined;
      if (selectedUserTarget && !users.some(user => user.id === selectedUserTarget.userId)) {
        const previous = selectedUserTarget;
        this.selectedTarget = undefined;
        this.post({ type: 'debugFlagsTargetStatus', target: previous, status: undefined });
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

  private async loadSelectedTargetStatus(target: TraceFlagTarget): Promise<void> {
    if (!target) {
      return;
    }
    const token = ++this.statusToken;
    this.post({ type: 'debugFlagsLoading', scope: 'status', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const status = await getTraceFlagTargetStatus(auth, target);
      if (token !== this.statusToken || this.disposed) {
        return;
      }
      const localizedStatus: TraceFlagTargetStatus = status.targetAvailable
        ? status
        : {
            ...status,
            unavailableReason: this.getTargetUnavailableReason(status.targetLabel)
          };
      this.post({
        type: 'debugFlagsTargetStatus',
        target,
        status: localizedStatus
      });
    } catch (e) {
      if (token !== this.statusToken || this.disposed) {
        return;
      }
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: failed loading target status ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.loadStatusFailed', 'Failed to load debug flag status for the selected target: {0}', msg)
      });
    } finally {
      if (token === this.statusToken && !this.disposed) {
        this.post({ type: 'debugFlagsLoading', scope: 'status', value: false });
      }
    }
  }

  private async applyTraceFlag(target: TraceFlagTarget, debugLevelName: string, ttlMinutes: number): Promise<void> {
    if (!target) {
      return;
    }
    const t0 = Date.now();
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const result = await upsertTraceFlag(auth, {
        target,
        debugLevelName,
        ttlMinutes
      });
      await this.loadSelectedTargetStatus(target);
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
          sourceView: this.lastSourceView,
          targetType: target.type
        },
        { durationMs: Date.now() - t0 }
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: apply failed ->', msg);
      const base = localize('debugFlags.applyFailed', 'Failed to apply debug flag: {0}', msg);
      const hint = this.isLogStorageFullErrorMessage(msg)
        ? localize(
            'logsCleanup.hintStorageFull',
            'Org log storage appears to be full. Use “Clear logs” → “All org logs” to free up space.'
          )
        : '';
      const fullMessage = hint ? `${base}\n\n${hint}` : base;
      this.post({ type: 'debugFlagsError', message: fullMessage });
      if (hint) {
        const clearAction = localize('logsCleanup.actionClearAll', 'Clear org logs…');
        void vscode.window.showErrorMessage(fullMessage, clearAction).then(selection => {
          if (selection === clearAction) {
            void this.clearLogs('all');
          }
        });
      } else {
        void vscode.window.showErrorMessage(fullMessage);
      }
      safeSendEvent(
        'debugFlags.apply',
        {
          outcome: 'error',
          sourceView: this.lastSourceView,
          targetType: target.type
        },
        { durationMs: Date.now() - t0 }
      );
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private normalizeDebugLevelDraft(draft: DebugLevelRecord): DebugLevelRecord {
    return {
      ...draft,
      developerName: String(draft.developerName || '').trim(),
      masterLabel: String(draft.masterLabel || '').trim(),
      language: String(draft.language || '').trim() || 'en_US',
      workflow: String(draft.workflow || '').trim(),
      validation: String(draft.validation || '').trim(),
      callout: String(draft.callout || '').trim(),
      apexCode: String(draft.apexCode || '').trim(),
      apexProfiling: String(draft.apexProfiling || '').trim(),
      visualforce: String(draft.visualforce || '').trim(),
      system: String(draft.system || '').trim(),
      database: String(draft.database || '').trim(),
      wave: String(draft.wave || '').trim(),
      nba: String(draft.nba || '').trim(),
      dataAccess: String(draft.dataAccess || '').trim()
    };
  }

  private async saveDebugLevel(draft: DebugLevelRecord): Promise<void> {
    const normalized = this.normalizeDebugLevelDraft(draft);
    if (!normalized.developerName) {
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.managerDeveloperNameRequired', 'DeveloperName is required.')
      });
      return;
    }
    if (!normalized.masterLabel) {
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.managerMasterLabelRequired', 'MasterLabel is required.')
      });
      return;
    }

    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const savedId = normalized.id
        ? (await updateDebugLevel(auth, normalized.id, normalized), normalized.id)
        : (await createDebugLevel(auth, normalized)).id;

      await this.sendDebugLevelData(auth, savedId);
      this.post({
        type: 'debugFlagsNotice',
        tone: 'success',
        message: normalized.id
          ? localize('debugFlags.managerUpdated', 'Debug level updated successfully.')
          : localize('debugFlags.managerCreated', 'Debug level created successfully.')
      });
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: save DebugLevel failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.managerSaveFailed', 'Failed to save debug level: {0}', msg)
      });
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private async removeDebugLevel(debugLevelId: string): Promise<void> {
    if (!debugLevelId) {
      return;
    }
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      await deleteDebugLevel(auth, debugLevelId);
      await this.sendDebugLevelData(auth);
      this.post({
        type: 'debugFlagsNotice',
        tone: 'success',
        message: localize('debugFlags.managerDeleted', 'Debug level deleted successfully.')
      });
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: delete DebugLevel failed ->', msg);
      this.post({
        type: 'debugFlagsError',
        message: localize('debugFlags.managerDeleteFailed', 'Failed to delete debug level: {0}', msg)
      });
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private async removeTraceFlag(target: TraceFlagTarget): Promise<void> {
    if (!target) {
      return;
    }
    const t0 = Date.now();
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const auth = await this.getSelectedAuth();
      const removed = await removeTraceFlags(auth, target);
      await this.loadSelectedTargetStatus(target);
      this.post({
        type: 'debugFlagsNotice',
        tone: removed > 0 ? 'success' : 'info',
        message:
          removed > 0
            ? localize('debugFlags.removeSuccess', 'Debug flag removed successfully.')
            : localize('debugFlags.removeNone', 'No active USER_DEBUG trace flag was found for this target.')
      });
      safeSendEvent(
        'debugFlags.remove',
        {
          outcome: 'ok',
          sourceView: this.lastSourceView,
          targetType: target.type
        },
        { durationMs: Date.now() - t0, removedCount: removed }
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: remove failed ->', msg);
      const base = localize('debugFlags.removeFailed', 'Failed to remove debug flag: {0}', msg);
      const hint = this.isLogStorageFullErrorMessage(msg)
        ? localize(
            'logsCleanup.hintStorageFull',
            'Org log storage appears to be full. Use “Clear logs” → “All org logs” to free up space.'
          )
        : '';
      const fullMessage = hint ? `${base}\n\n${hint}` : base;
      this.post({ type: 'debugFlagsError', message: fullMessage });
      if (hint) {
        const clearAction = localize('logsCleanup.actionClearAll', 'Clear org logs…');
        void vscode.window.showErrorMessage(fullMessage, clearAction).then(selection => {
          if (selection === clearAction) {
            void this.clearLogs('all');
          }
        });
      } else {
        void vscode.window.showErrorMessage(fullMessage);
      }
      safeSendEvent(
        'debugFlags.remove',
        {
          outcome: 'error',
          sourceView: this.lastSourceView,
          targetType: target.type
        },
        { durationMs: Date.now() - t0 }
      );
    } finally {
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private getTargetUnavailableReason(targetLabel: string): string {
    return localize(
      'debugFlags.targetUnavailable',
      'The trace flag target "{0}" is not available in this org.',
      targetLabel
    );
  }

  private isAbortLikeError(err: unknown, message?: string): boolean {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      return true;
    }
    const normalized = String(message ?? getErrorMessage(err) ?? '').toLowerCase();
    return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
  }

  private isLogStorageFullErrorMessage(message: string): boolean {
    const m = String(message || '').toLowerCase();
    if (!m) {
      return false;
    }
    if (m.includes('storage_limit_exceeded')) {
      return true;
    }
    if (m.includes('log storage') && (m.includes('full') || m.includes('limit') || m.includes('exceed'))) {
      return true;
    }
    if (m.includes('debug log') && (m.includes('full') || m.includes('limit') || m.includes('exceed'))) {
      return true;
    }
    if (m.includes('apexlog') && (m.includes('full') || m.includes('limit') || m.includes('exceed'))) {
      return true;
    }
    if (m.includes('apex log') && (m.includes('full') || m.includes('limit') || m.includes('exceed'))) {
      return true;
    }
    return false;
  }

  private async clearLogs(scope: 'all' | 'mine'): Promise<void> {
    if (this.clearLogsInProgress) {
      this.post({
        type: 'debugFlagsNotice',
        tone: 'info',
        message: localize('logsCleanup.alreadyRunning', 'A log cleanup is already in progress.')
      });
      return;
    }
    this.clearLogsInProgress = true;
    const t0 = Date.now();
    this.post({ type: 'debugFlagsLoading', scope: 'action', value: true });
    try {
      const confirmAction = localize('logsCleanup.confirmAction', 'Delete');
      const confirmation = await vscode.window.showWarningMessage(
        scope === 'mine'
          ? localize('logsCleanup.confirmMine.title', 'Delete your Apex logs for the selected org?')
          : localize('logsCleanup.confirmAll.title', 'Delete all Apex logs for the selected org?'),
        {
          modal: true,
          detail:
            scope === 'mine'
              ? localize(
                  'logsCleanup.confirmMine.detail',
                  "This permanently deletes ApexLog records whose LogUser matches the currently authenticated org user. It can't be undone."
                )
              : localize(
                  'logsCleanup.confirmAll.detail',
                  "This permanently deletes ApexLog records stored in the org. It can't be undone."
                )
        },
        confirmAction
      );
      if (confirmation !== confirmAction) {
        safeSendEvent(
          'logs.cleanup',
          { outcome: 'cancel', scope, sourceView: this.lastSourceView },
          { durationMs: Date.now() - t0 }
        );
        return;
      }

      type CleanupRunResult =
        | { kind: 'cancelled'; deleted: number; failed: number; total: number }
        | { kind: 'empty' }
        | { kind: 'done'; deleted: number; failed: number; cancelled: number; total: number };
      const runResult = await vscode.window.withProgress<CleanupRunResult>(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            scope === 'mine'
              ? localize('logsCleanup.progressTitleMine', 'Deleting my org logs…')
              : localize('logsCleanup.progressTitleAll', 'Deleting org logs…'),
          cancellable: true
        },
        async (progress, ct) => {
          const controller = new AbortController();
          ct.onCancellationRequested(() => controller.abort());

          progress.report({
            message:
              scope === 'mine'
                ? localize('logsCleanup.progressListingMine', 'Listing your Apex logs…')
                : localize('logsCleanup.progressListingAll', 'Listing Apex logs in the org…')
          });

          let progressPct = 0;
          let auth;
          try {
            auth = await this.getSelectedAuth(controller.signal);
          } catch (e) {
            const msg = getErrorMessage(e);
            if (controller.signal.aborted || this.isAbortLikeError(e, msg)) {
              return { kind: 'cancelled', deleted: 0, failed: 0, total: 0 };
            }
            throw e;
          }

          let cleanup;
          try {
            cleanup = await clearApexLogs(auth, scope, {
              signal: controller.signal,
              concurrency: 3,
              onProgress: p => {
                if (p.stage !== 'deleting' || p.total <= 0) {
                  return;
                }
                const nextPct = Math.max(0, Math.min(100, Math.floor((p.processed / p.total) * 100)));
                const increment = nextPct - progressPct;
                progressPct = nextPct;
                progress.report({
                  message: localize('logsCleanup.progressDeleting', 'Deleting logs ({0}/{1})…', p.processed, p.total),
                  increment: increment > 0 ? increment : undefined
                });
              }
            });
          } catch (e) {
            const msg = getErrorMessage(e);
            if (controller.signal.aborted || this.isAbortLikeError(e, msg)) {
              return { kind: 'cancelled', deleted: 0, failed: 0, total: 0 };
            }
            throw e;
          }

          if (controller.signal.aborted || ct.isCancellationRequested) {
            return {
              kind: 'cancelled',
              deleted: cleanup.deleted,
              failed: cleanup.failed,
              total: cleanup.total
            };
          }
          if (cleanup.total === 0) {
            return { kind: 'empty' };
          }
          return {
            kind: 'done',
            deleted: cleanup.deleted,
            failed: cleanup.failed,
            cancelled: cleanup.cancelled,
            total: cleanup.total
          };
        }
      );

      if (runResult.kind === 'empty') {
        this.post({
          type: 'debugFlagsNotice',
          tone: 'info',
          message:
            scope === 'mine'
              ? localize('logsCleanup.emptyMine', 'No Apex logs were found for the authenticated user.')
              : localize('logsCleanup.emptyAll', 'No Apex logs were found in the org.')
        });
      } else if (runResult.kind === 'cancelled') {
        this.post({
          type: 'debugFlagsNotice',
          tone: 'info',
          message: localize(
            'logsCleanup.cancelledCounts',
            'Log cleanup cancelled (deleted {0}, failed {1}).',
            runResult.deleted,
            runResult.failed
          )
        });
      } else if (runResult.failed > 0) {
        this.post({
          type: 'debugFlagsNotice',
          tone: 'warning',
          message: localize(
            'logsCleanup.partial',
            'Deleted {0} log(s), but {1} failed.',
            runResult.deleted,
            runResult.failed
          )
        });
      } else {
        this.post({
          type: 'debugFlagsNotice',
          tone: 'success',
          message: localize('logsCleanup.done', 'Deleted {0} Apex log(s).', runResult.deleted)
        });
      }

      safeSendEvent(
        'logs.cleanup',
        { outcome: runResult.kind, scope, sourceView: this.lastSourceView },
        { durationMs: Date.now() - t0 }
      );
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('DebugFlagsPanel: clear logs failed ->', msg);
      vscode.window.showErrorMessage(localize('logsCleanup.failed', 'Failed to clear logs: {0}', msg));
      this.post({
        type: 'debugFlagsError',
        message: localize('logsCleanup.failed', 'Failed to clear logs: {0}', msg)
      });
      safeSendEvent(
        'logs.cleanup',
        { outcome: 'error', scope, sourceView: this.lastSourceView },
        { durationMs: Date.now() - t0 }
      );
    } finally {
      this.clearLogsInProgress = false;
      this.post({ type: 'debugFlagsLoading', scope: 'action', value: false });
    }
  }

  private async getSelectedAuth(signal?: AbortSignal) {
    const selected = (this.selectedOrg || '').trim();
    if (!selected) {
      throw new Error(localize('debugFlags.noOrg', 'No Salesforce org is selected.'));
    }
    return getOrgAuth(selected, undefined, signal);
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
