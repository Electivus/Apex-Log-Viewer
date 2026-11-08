import * as vscode from 'vscode';
import { localize } from '../host/utils/localize';
import { logInfo, logWarn } from '../host/utils/logger';
import { getErrorMessage } from '../host/utils/error';
import { trimOldest } from '../host/utils/trimOldest';
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
  type CustomLogViewerFieldTarget,
  type CustomLogViewerToWebviewMessage
} from '../shared/customLogViewerMessages';
import type { CustomLogApexLogLink } from '../shared/customLogsTypes';
import { buildEntryFields, buildHeaderPayloadField, type BuiltLongFields, type HeldLongText } from './customLogFields';

export interface CustomLogViewerShowOptions {
  targetOrg?: string;
  sourceId: string;
  /** The header record (a `transactions` source) or any entry of the transaction (an `entries` source). */
  logId: string;
  /** The entry JSON columns the source's mapping defaults, as the list that opens the log holds them. */
  payloadDefaults: readonly string[];
  /** The entry the user opened. The panel pages until it holds it, then tells the webview to select it. */
  focusEntryId?: string;
}

const ENTRIES_PAGE_SIZE = 200;
const CHASE_PAGE_SIZE = 2_000;
/** Bounds what one focus brings into the webview, so opening an entry of a huge transaction stays responsive. */
const MAX_CHASED_ENTRIES = 10_000;
const MAX_HELD_ENTRIES = 50;

type ErrorScope = Extract<CustomLogViewerToWebviewMessage, { type: 'customLogViewerError' }>['scope'];
type HeldEntry = { sequence: number; fields: BuiltLongFields };

/** Where the next `get` page starts: unknown before the first page lands, `null` once every entry is delivered. */
type EntryPages = { state: 'unloaded' } | { state: 'loaded'; cursor: string | null };

/**
 * The entry the list opened, from the request until the panel delivers it (`found`) or delivers every entry
 * without it (`notFound`). Past MAX_CHASED_ENTRIES the panel answers `notLoaded` and stays pending, so the
 * user's Load more can still find it. A newer request replaces an older one.
 */
type Focus = { state: 'idle' } | { state: 'pending'; entryId: string };
type FocusAnswer = Extract<CustomLogViewerToWebviewMessage, { type: 'customLogViewerFocus' }>['state'];

const IDLE: Focus = { state: 'idle' };

export class CustomLogViewerPanel {
  private static context: vscode.ExtensionContext | undefined;
  private static payloadColumns: PayloadColumnsStore | undefined;
  private static readonly panels = new Map<string, CustomLogViewerPanel>();
  static readonly viewType = 'electivus.apexLogViewer.customLogs.viewerPanel';

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
      existing.focus(options.focusEntryId);
      return;
    }
    const viewer = new CustomLogViewerPanel(context, payloadColumns, options, () => this.panels.delete(key));
    this.panels.set(key, viewer);
    viewer.focus(options.focusEntryId);
  }

  static closeAll(): void {
    for (const viewer of [...this.panels.values()]) {
      viewer.panel.dispose();
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly logService = new LogService();
  private ready = false;
  private disposed = false;
  private loadController: AbortController | undefined;
  private title: string;
  private apexLog: CustomLogApexLogLink = { state: 'noRequestId' };
  private headerPayload: HeldLongText | undefined;
  private pages: EntryPages = { state: 'unloaded' };
  private pendingFocus: Focus = IDLE;
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
      case 'customLogViewerCopyField':
        await this.copyField(message.target);
        break;
      case 'customLogViewerOpenApexLog':
        await this.openApexLog();
        break;
      case 'customLogViewerShowPayloadColumn':
        await this.showPayloadColumn(message.path, message.shown);
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

  /** Starts a delivery, cancelling the one in flight: a refresh supersedes a Load more and the reverse. */
  private begin(): AbortSignal {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    return controller.signal;
  }

  private end(signal: AbortSignal): void {
    if (this.loadController?.signal === signal) {
      this.loadController = undefined;
    }
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
      const detail = await runtimeClient.customLogGet(
        { ...this.scope(projectDir), logId: this.options.logId, limit: ENTRIES_PAGE_SIZE },
        signal
      );
      if (signal.aborted || this.disposed) {
        return;
      }
      this.apexLog = detail.apexLog;
      this.pages = { state: 'loaded', cursor: detail.nextCursor };
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
        payloadColumns: this.payloadColumns.read(this.options.sourceId, this.options.payloadDefaults),
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
      await this.settleFocus(signal);
    } catch (error) {
      if (signal.aborted || this.disposed) {
        return;
      }
      this.showFailure('log', error);
      this.recordFailure('customLogs.openLog', startedAt, error);
    } finally {
      if (!signal.aborted && !this.disposed) {
        this.post({ type: 'customLogViewerLoading', scope: 'log', value: false });
        this.post({ type: 'customLogViewerLoading', scope: 'entries', value: false });
      }
      this.end(signal);
    }
  }

  private async loadMoreEntries(): Promise<void> {
    if (this.pages.state !== 'loaded' || this.pages.cursor === null) {
      return;
    }
    const signal = this.begin();
    try {
      if (await this.appendPage(ENTRIES_PAGE_SIZE, signal)) {
        await this.settleFocus(signal);
      }
    } finally {
      this.end(signal);
    }
  }

  /** The next page after the cursor, appended to the webview's entries. False when it was cancelled or failed. */
  private async appendPage(limit: number, signal: AbortSignal): Promise<boolean> {
    const cursor = this.pages.state === 'loaded' ? this.pages.cursor : null;
    if (cursor === null) {
      return false;
    }
    this.post({ type: 'customLogViewerLoading', scope: 'entries', value: true });
    try {
      const projectDir = await findCustomLogsProjectDir();
      const detail = await runtimeClient.customLogGet(
        { ...this.scope(projectDir), logId: this.options.logId, cursor, limit },
        signal
      );
      if (signal.aborted || this.disposed) {
        return false;
      }
      this.pages = { state: 'loaded', cursor: detail.nextCursor };
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
      return true;
    } catch (error) {
      if (!signal.aborted && !this.disposed) {
        this.showFailure('entries', error);
      }
      return false;
    } finally {
      if (!signal.aborted && !this.disposed) {
        this.post({ type: 'customLogViewerLoading', scope: 'entries', value: false });
      }
    }
  }

  /**
   * Asks the panel to select `entryId` once it holds it. Safe to repeat: a second request for the same entry
   * settles again and posts the same answer.
   */
  private focus(entryId: string | undefined): void {
    if (entryId === undefined) {
      return;
    }
    this.pendingFocus = { state: 'pending', entryId };
    // Before the webview is ready, its first load settles the focus; during a delivery, that delivery does.
    if (!this.ready || this.loadController) {
      return;
    }
    const signal = this.begin();
    void this.settleFocus(signal).finally(() => this.end(signal));
  }

  /**
   * Runs after every delivery. Chases pages of CHASE_PAGE_SIZE until the pending entry is delivered, the
   * entries run out, or MAX_CHASED_ENTRIES are delivered. The request is read again after each page and
   * answered before the next await, so a request made during the chase is the one answered.
   */
  private async settleFocus(signal: AbortSignal): Promise<void> {
    for (;;) {
      const focus = this.pendingFocus;
      if (focus.state !== 'pending' || this.pages.state !== 'loaded' || signal.aborted || this.disposed) {
        return;
      }
      if (this.deliveredEntryIds.has(focus.entryId)) {
        this.answerFocus(focus, 'found');
        return;
      }
      if (this.pages.cursor === null) {
        this.answerFocus(focus, 'notFound');
        return;
      }
      if (this.deliveredEntryIds.size >= MAX_CHASED_ENTRIES) {
        this.answerFocus(focus, 'notLoaded');
        return;
      }
      if (!(await this.appendPage(CHASE_PAGE_SIZE, signal))) {
        return;
      }
    }
  }

  private answerFocus(focus: Extract<Focus, { state: 'pending' }>, state: FocusAnswer): void {
    if (state !== 'notLoaded') {
      this.pendingFocus = IDLE;
    }
    this.post({ type: 'customLogViewerFocus', entryId: focus.entryId, state });
  }

  private async fetchEntry(entryId: string): Promise<HeldEntry> {
    const projectDir = await findCustomLogsProjectDir();
    const result = await runtimeClient.customLogEntry({ ...this.scope(projectDir), entryId });
    const held: HeldEntry = { sequence: result.entry.sequence, fields: buildEntryFields(result, this.labels()) };
    this.heldEntries.delete(entryId);
    this.heldEntries.set(entryId, held);
    trimOldest(this.heldEntries, MAX_HELD_ENTRIES);
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
        this.showFailure('entry', error);
        this.recordFailure('customLogs.openEntry', startedAt, error);
      }
    } finally {
      this.post({ type: 'customLogViewerLoading', scope: 'entry', value: false });
    }
  }

  /** The whole value of a field the panel delivered, reading its entry once when the panel no longer holds it. */
  private async heldField(
    target: CustomLogViewerFieldTarget
  ): Promise<{ held: HeldLongText; sequence?: number } | undefined> {
    if (target.kind === 'logPayload') {
      return this.headerPayload && { held: this.headerPayload };
    }
    if (!this.deliveredEntryIds.has(target.entryId)) {
      logWarn('CustomLogViewerPanel: ignored a field of an entry that was not delivered');
      return undefined;
    }
    const entry = this.heldEntries.get(target.entryId) ?? (await this.fetchEntry(target.entryId));
    const held = entry.fields.held.get(target.key);
    return held && { held, sequence: entry.sequence };
  }

  private async openField(target: CustomLogViewerFieldTarget): Promise<void> {
    const startedAt = Date.now();
    try {
      const field = await this.heldField(target);
      if (!field) {
        logWarn('CustomLogViewerPanel: ignored openField for a field the panel does not hold');
        return;
      }
      const { held, sequence } = field;
      const kind =
        target.kind === 'logPayload' || target.key === 'payload'
          ? 'payload'
          : target.key === 'message'
            ? 'message'
            : 'detail';
      const suffix = sequence === undefined ? '' : ` #${sequence}`;
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
        this.showFailure('field', error);
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
      this.showFailure('apexLog', error);
      safeSendEvent('customLogs.openApexLog', { outcome: 'error', code: getTelemetryErrorCode(error) });
    }
  }

  private async showPayloadColumn(path: string, shown: boolean): Promise<void> {
    await this.payloadColumns.show(this.options.sourceId, path, shown);
    const value = this.payloadColumns.read(this.options.sourceId, this.options.payloadDefaults);
    this.post({ type: 'customLogViewerPayloadColumns', value });
    safeSendEvent('customLogs.payloadColumns', { outcome: 'ok', level: 'entry' }, { count: value.added.length });
  }

  private async copyField(target: CustomLogViewerFieldTarget): Promise<void> {
    try {
      const field = await this.heldField(target);
      if (!field) {
        logWarn('CustomLogViewerPanel: ignored copyField for a field the panel does not hold');
        return;
      }
      await this.copyText(field.held.text);
    } catch (error) {
      if (!this.disposed) {
        this.showFailure('entry', error);
      }
    }
  }

  private async copyText(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      logWarn('CustomLogViewerPanel: copy failed ->', getErrorMessage(error));
    }
  }

  private showFailure(scope: ErrorScope, error: unknown): void {
    const message = getErrorMessage(error);
    logWarn(`CustomLogViewerPanel: ${scope} failed ->`, message);
    this.post({ type: 'customLogViewerError', scope, message });
  }

  private recordFailure(event: 'customLogs.openLog' | 'customLogs.openEntry', startedAt: number, error: unknown): void {
    safeSendEvent(
      event,
      { outcome: 'error', code: getTelemetryErrorCode(error) },
      { durationMs: Date.now() - startedAt }
    );
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
