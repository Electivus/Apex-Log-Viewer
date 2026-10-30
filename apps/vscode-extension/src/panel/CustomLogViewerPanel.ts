import * as vscode from 'vscode';
import { localize } from '../host/utils/localize';
import { logInfo, logWarn } from '../host/utils/logger';
import { getErrorMessage } from '../host/utils/error';
import { recordInboundMessage } from '../host/utils/responsiveness';
import { buildWebviewHtml } from '../host/utils/webviewHtml';
import { findCustomLogsProjectDir } from '../host/utils/workspace';
import { openCustomLogDocument } from '../host/utils/customLogDocuments';
import { LogService } from '../host/services/logService';
import { createPayloadColumnsStore, type PayloadColumnsStore } from '../provider/customLogsPayloadColumns';
import { runtimeClient } from '../runtime/runtimeClient';
import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';
import {
  parseCustomLogViewerFromWebviewMessage,
  type CustomLogViewerToWebviewMessage
} from '../shared/customLogViewerMessages';
import type { CustomLogApexLogLink } from '../shared/customLogsTypes';
import { buildEntryFields, buildHeaderPayloadField, type BuiltLongFields, type HeldLongText } from './customLogFields';

export interface CustomLogViewerShowOptions {
  targetOrg?: string;
  sourceId: string;
  /** The header record (a `transactions` source) or any entry of the transaction (an `entries` source). */
  logId: string;
}

const ENTRIES_PAGE_SIZE = 200;
const MAX_HELD_ENTRIES = 50;

type ErrorScope = Extract<CustomLogViewerToWebviewMessage, { type: 'customLogViewerError' }>['scope'];
type HeldEntry = { sequence: number; fields: BuiltLongFields };
type OpenFieldTarget = Extract<
  NonNullable<ReturnType<typeof parseCustomLogViewerFromWebviewMessage>>,
  { type: 'customLogViewerOpenField' }
>['target'];

export class CustomLogViewerPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static payloadColumns: PayloadColumnsStore | undefined;
  private static readonly panels = new Map<string, CustomLogViewerPanel>();
  private static readonly viewType = 'electivus.apexLogViewer.customLogs.viewerPanel';

  static initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.payloadColumns = createPayloadColumnsStore(context.workspaceState);
  }

  static async show(options: CustomLogViewerShowOptions): Promise<void> {
    const context = this.context;
    const payloadColumns = this.payloadColumns;
    if (!context || !payloadColumns) {
      return;
    }
    const key = [options.targetOrg ?? '', options.sourceId, options.logId].join('|');
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }
    this.panels.set(key, new CustomLogViewerPanel(context, payloadColumns, options, () => this.panels.delete(key)));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly logService = new LogService();
  private ready = false;
  private disposed = false;
  private loadController: AbortController | undefined;
  private title: string;
  private apexLog: CustomLogApexLogLink = { state: 'noRequestId' };
  private payloadDefaults: string[] = [];
  private headerPayload: HeldLongText | undefined;
  private cursor: string | null = null;
  private readonly deliveredEntryIds = new Set<string>();
  private readonly heldEntries = new Map<string, HeldEntry>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly payloadColumns: PayloadColumnsStore,
    private readonly options: CustomLogViewerShowOptions,
    private readonly forget: () => void
  ) {
    this.title = localize('customLogs.viewer.title', 'Custom log');
    this.panel = vscode.window.createWebviewPanel(
      CustomLogViewerPanel.viewType,
      this.title,
      { viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    this.panel.webview.html = buildWebviewHtml(
      this.panel.webview,
      context.extensionUri,
      'customLogViewer.js',
      this.title
    );
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    context.subscriptions.push(this.panel);
    logInfo('CustomLogViewerPanel: created panel for', options.logId);
  }

  private async onMessage(raw: unknown): Promise<void> {
    recordInboundMessage('customLogViewer', raw);
    const message = parseCustomLogViewerFromWebviewMessage(raw);
    if (!message || this.disposed) {
      return;
    }
    switch (message.type) {
      case 'customLogViewerReady':
        this.ready = true;
        await this.load();
        break;
      case 'customLogViewerRefresh':
        await this.load();
        break;
      case 'customLogViewerLoadMoreEntries':
        await this.loadMoreEntries();
        break;
      case 'customLogViewerOpenEntry':
        await this.openEntry(message.entryId);
        break;
      case 'customLogViewerOpenField':
        await this.openField(message.target);
        break;
      case 'customLogViewerOpenApexLog':
        await this.openApexLog();
        break;
      case 'customLogViewerSetPayloadColumns':
        await this.setPayloadColumns(message.added);
        break;
      case 'customLogViewerCopyText':
        await this.copyText(message.text);
        break;
    }
  }

  private post(message: CustomLogViewerToWebviewMessage): void {
    if (this.ready && !this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private begin(): AbortSignal {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    return controller.signal;
  }

  private scope(projectDir: string | undefined) {
    return { targetOrg: this.options.targetOrg, projectDir, source: this.options.sourceId };
  }

  private labels() {
    return {
      message: localize('customLogs.field.message', 'Message'),
      payload: localize('customLogs.field.payload', 'Payload')
    };
  }

  private async load(): Promise<void> {
    const signal = this.begin();
    this.post({ type: 'customLogViewerLoading', scope: 'log', value: true });
    this.post({ type: 'customLogViewerLoading', scope: 'entries', value: true });
    const startedAt = Date.now();
    try {
      const projectDir = await findCustomLogsProjectDir();
      const [detail, sources] = await Promise.all([
        runtimeClient.customLogGet(
          { ...this.scope(projectDir), logId: this.options.logId, limit: ENTRIES_PAGE_SIZE },
          signal
        ),
        runtimeClient.customLogSources({ targetOrg: this.options.targetOrg, projectDir }, signal).catch(error => {
          if (signal.aborted) throw error;
          logWarn('CustomLogViewerPanel: could not read the source defaults ->', getErrorMessage(error));
          return undefined;
        })
      ]);
      if (signal.aborted || this.disposed) {
        return;
      }
      this.apexLog = detail.apexLog;
      this.cursor = detail.nextCursor;
      this.payloadDefaults =
        sources?.sources.find(source => source.id === detail.source.id)?.payload.entry?.columns ?? [];
      const header = buildHeaderPayloadField(detail.logPayload, this.labels().payload);
      this.headerPayload = header?.held;
      this.title = detail.log.title ?? this.options.logId;
      this.panel.title = localize('customLogs.viewer.panelTitle', 'Custom log: {0}', this.title);
      this.deliveredEntryIds.clear();
      this.heldEntries.clear();
      for (const entry of detail.entries) {
        this.deliveredEntryIds.add(entry.id);
      }
      this.post({
        type: 'customLogViewerInit',
        locale: vscode.env.language,
        source: detail.source,
        log: detail.log,
        ...(header ? { logPayload: header.view } : {}),
        entryColumns: detail.entryColumns,
        payloadColumns: this.payloadColumns.read(this.options.sourceId, 'entry', this.payloadDefaults),
        apexLog: detail.apexLog
      });
      this.post({
        type: 'customLogViewerEntries',
        mode: 'replace',
        entries: detail.entries,
        payloadFields: detail.payloadFields,
        hasMore: detail.nextCursor !== null
      });
      safeSendEvent('customLogs.openLog', { outcome: 'ok' }, { durationMs: Date.now() - startedAt });
    } catch (error) {
      if (signal.aborted || this.disposed) {
        return;
      }
      this.fail('log', error, 'customLogs.openLog', startedAt);
    } finally {
      if (!signal.aborted && !this.disposed) {
        this.post({ type: 'customLogViewerLoading', scope: 'log', value: false });
        this.post({ type: 'customLogViewerLoading', scope: 'entries', value: false });
      }
    }
  }

  private async loadMoreEntries(): Promise<void> {
    const cursor = this.cursor;
    if (cursor === null) {
      return;
    }
    const signal = this.begin();
    this.post({ type: 'customLogViewerLoading', scope: 'entries', value: true });
    try {
      const projectDir = await findCustomLogsProjectDir();
      const detail = await runtimeClient.customLogGet(
        { ...this.scope(projectDir), logId: this.options.logId, cursor, limit: ENTRIES_PAGE_SIZE },
        signal
      );
      if (signal.aborted || this.disposed) {
        return;
      }
      this.cursor = detail.nextCursor;
      for (const entry of detail.entries) {
        this.deliveredEntryIds.add(entry.id);
      }
      this.post({
        type: 'customLogViewerEntries',
        mode: 'append',
        entries: detail.entries,
        payloadFields: detail.payloadFields,
        hasMore: detail.nextCursor !== null
      });
    } catch (error) {
      if (!signal.aborted && !this.disposed) {
        this.fail('entries', error);
      }
    } finally {
      if (!signal.aborted && !this.disposed) {
        this.post({ type: 'customLogViewerLoading', scope: 'entries', value: false });
      }
    }
  }

  private async fetchEntry(entryId: string): Promise<HeldEntry> {
    const projectDir = await findCustomLogsProjectDir();
    const result = await runtimeClient.customLogEntry({ ...this.scope(projectDir), entryId });
    const held: HeldEntry = { sequence: result.entry.sequence, fields: buildEntryFields(result, this.labels()) };
    this.heldEntries.delete(entryId);
    this.heldEntries.set(entryId, held);
    for (const oldest of [...this.heldEntries.keys()].slice(0, Math.max(0, this.heldEntries.size - MAX_HELD_ENTRIES))) {
      this.heldEntries.delete(oldest);
    }
    return held;
  }

  private async openEntry(entryId: string): Promise<void> {
    if (!this.deliveredEntryIds.has(entryId)) {
      logWarn('CustomLogViewerPanel: ignored openEntry for an entry that was not delivered');
      return;
    }
    const startedAt = Date.now();
    this.post({ type: 'customLogViewerLoading', scope: 'entry', value: true });
    try {
      const { fields } = await this.fetchEntry(entryId);
      this.post({ type: 'customLogViewerEntryFields', entryId, fields: fields.views });
      safeSendEvent('customLogs.openEntry', { outcome: 'ok' }, { durationMs: Date.now() - startedAt });
    } catch (error) {
      if (!this.disposed) {
        this.fail('entry', error, 'customLogs.openEntry', startedAt);
      }
    } finally {
      this.post({ type: 'customLogViewerLoading', scope: 'entry', value: false });
    }
  }

  private async openField(target: OpenFieldTarget): Promise<void> {
    const startedAt = Date.now();
    try {
      let held: HeldLongText | undefined;
      let suffix = '';
      let kind: 'message' | 'detail' | 'payload' = 'payload';
      if (target.kind === 'logPayload') {
        held = this.headerPayload;
      } else {
        if (!this.deliveredEntryIds.has(target.entryId)) {
          logWarn('CustomLogViewerPanel: ignored openField for an entry that was not delivered');
          return;
        }
        const entry = this.heldEntries.get(target.entryId) ?? (await this.fetchEntry(target.entryId));
        held = entry.fields.held.get(target.key);
        suffix = ` #${entry.sequence}`;
        kind = target.key === 'message' ? 'message' : target.key === 'payload' ? 'payload' : 'detail';
      }
      if (!held) {
        logWarn('CustomLogViewerPanel: ignored openField for a field the panel does not hold');
        return;
      }
      await openCustomLogDocument({
        name: `${held.label} - ${this.title}${suffix}`,
        text: held.text,
        format: held.format
      });
      safeSendEvent(
        'customLogs.openField',
        { outcome: 'ok', kind, format: held.format },
        { durationMs: Date.now() - startedAt }
      );
    } catch (error) {
      if (!this.disposed) {
        this.fail('field', error);
        safeSendEvent('customLogs.openField', { outcome: 'error', code: getTelemetryErrorCode(error) });
      }
    }
  }

  private async openApexLog(): Promise<void> {
    const link = this.apexLog;
    if (link.state !== 'linked') {
      logWarn('CustomLogViewerPanel: ignored openApexLog without a linked Apex log');
      safeSendEvent('customLogs.openApexLog', { outcome: link.state });
      return;
    }
    try {
      await this.logService.openLog(link.logId, this.options.targetOrg);
      safeSendEvent('customLogs.openApexLog', { outcome: 'linked' });
    } catch (error) {
      this.fail('apexLog', error);
      safeSendEvent('customLogs.openApexLog', { outcome: 'error', code: getTelemetryErrorCode(error) });
    }
  }

  private async setPayloadColumns(added: string[]): Promise<void> {
    await this.payloadColumns.write(this.options.sourceId, 'entry', added);
    const value = this.payloadColumns.read(this.options.sourceId, 'entry', this.payloadDefaults);
    this.post({ type: 'customLogViewerPayloadColumns', value });
    safeSendEvent('customLogs.payloadColumns', { outcome: 'ok', level: 'entry' }, { count: value.added.length });
  }

  private async copyText(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      logWarn('CustomLogViewerPanel: copy failed ->', getErrorMessage(error));
    }
  }

  private fail(
    scope: ErrorScope,
    error: unknown,
    event?: 'customLogs.openLog' | 'customLogs.openEntry',
    startedAt?: number
  ): void {
    const message = getErrorMessage(error);
    logWarn(`CustomLogViewerPanel: ${scope} failed ->`, message);
    this.post({ type: 'customLogViewerError', scope, message });
    if (event) {
      safeSendEvent(
        event,
        { outcome: 'error', code: getTelemetryErrorCode(error) },
        { durationMs: Date.now() - (startedAt ?? Date.now()) }
      );
    }
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.loadController?.abort();
    this.forget();
  }
}
