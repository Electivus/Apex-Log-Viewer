import * as vscode from 'vscode';
import { localize } from '../host/utils/localize';
import { logInfo, logWarn } from '../host/utils/logger';
import { recordInboundMessage } from '../host/utils/responsiveness';
import { getErrorMessage } from '../host/utils/error';
import { pickSelectedOrg } from '../host/utils/orgs';
import { buildWebviewHtml } from '../host/utils/webviewHtml';
import { findCustomLogsProjectDir, onSfdxProjectFileChanged } from '../host/utils/workspace';
import { openCustomLogDocument } from '../host/utils/customLogDocuments';
import { CustomLogViewerPanel } from '../panel/CustomLogViewerPanel';
import { runtimeClient } from '../runtime/runtimeClient';
import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';
import { recordWebviewEvent, type WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';
import {
  parseCustomLogsFromWebviewMessage,
  type CustomLogsFromWebviewMessage,
  type CustomLogsToWebviewMessage
} from '../shared/customLogsMessages';
import {
  mergePayloadFields,
  type CustomLogColumn,
  type CustomLogConfigIssueView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from '../shared/customLogsTypes';
import type { OrgItem } from '../shared/types';
import { createWebviewPanelHost, createWebviewViewHost, type BoundWebviewHost } from './webviewHost';
import {
  createWebviewSession,
  type WebviewSession,
  type WebviewSessionDetachReason,
  type WebviewSessionDiagnostic,
  type WebviewSessionInbound
} from './webviewSession';
import {
  createPayloadColumnsStore,
  type CustomLogPayloadLevel,
  type PayloadColumnsStore
} from './customLogsPayloadColumns';

const PAGE_SIZE = 50;

export const CUSTOM_LOGS_COMMANDS = {
  configure: 'electivus.apexLogViewer.customLogs.configure',
  openEditor: 'electivus.apexLogViewer.customLogs.openEditor'
} as const;

function levelOf(source: CustomLogSourceView): CustomLogPayloadLevel {
  return source.shape === 'transactions' ? 'transaction' : 'entry';
}

/** The previous choice while it is still ready, else the only ready source core names, else the first ready one. */
function pickSourceId(
  sources: readonly CustomLogSourceView[],
  preferred: string | undefined,
  defaultSourceId: string | undefined
): string | undefined {
  const ready = (id: string | undefined) => sources.find(source => source.id === id && source.state === 'ready')?.id;
  return ready(preferred) ?? ready(defaultSourceId) ?? sources.find(source => source.state === 'ready')?.id;
}

/** Core refuses a filter the source cannot apply, so the provider keeps only what the selected source supports. */
function restrictFilter(filter: CustomLogsFilterView, source: CustomLogSourceView | undefined): CustomLogsFilterView {
  if (!source) {
    return filter;
  }
  return {
    ...(filter.minLevel && source.capabilities.levelFilter ? { minLevel: filter.minLevel } : {}),
    ...(filter.user && source.capabilities.userFilter ? { user: filter.user } : {}),
    ...(filter.since ? { since: filter.since } : {})
  };
}

function isAbortLike(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'AbortError';
}

export class CustomLogsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'electivus.apexLogViewer.customLogsView';
  private view?: { webview: vscode.Webview };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session: WebviewSession<CustomLogsToWebviewMessage, BoundWebviewHost>;
  private readonly payloadColumnsStore: PayloadColumnsStore;
  private sessionDiagnostic: WebviewSessionDiagnostic | undefined;
  private disposed = false;
  private surface: 'view' | 'editor' = 'view';
  private requestController: AbortController | undefined;
  private bootstrapNeedsRefresh = true;
  private projectConfigPending = false;

  // The authoritative replay snapshot: `post` updates it before it delivers.
  private selectedOrg: string | undefined;
  private orgs: OrgItem[] = [];
  private hasOrgsSnapshot = false;
  private sources: CustomLogSourceView[] = [];
  private issues: CustomLogConfigIssueView[] = [];
  private hasSourcesSnapshot = false;
  private selectedSourceId: string | undefined;
  private preferredSourceId: string | undefined;
  private filter: CustomLogsFilterView = {};
  private payloadColumns: CustomLogPayloadColumnsView = { defaults: [], added: [] };
  private columns: CustomLogColumn[] = [];
  private rows: CustomLogRow[] = [];
  private payloadFields: CustomLogPayloadField[] = [];
  private hasMore = false;
  private hasPageSnapshot = false;
  private cursor: string | null = null;
  private loadingState = false;
  private errorMessage: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.payloadColumnsStore = createPayloadColumnsStore(context.workspaceState);
    this.session = createWebviewSession({
      mount: (host, generation) => {
        host.webview.html = this.getHtmlForWebview(host.webview, generation);
        logInfo('Custom Logs webview mounted.');
      },
      getReplaySnapshot: () => this.getReplaySnapshot(),
      onInboundReceived: message => recordInboundMessage('customLogs', message),
      validateInbound: message => this.validateInbound(message),
      onDetach: reason => this.handleSessionDetach(reason),
      onMessage: message => this.handleMessage(message),
      onReady: () => this.bootstrapWebview(),
      onDiagnostic: diagnostic => this.handleSessionDiagnostic(diagnostic)
    });
    this.disposables.push(onSfdxProjectFileChanged(() => void this.onProjectConfigChanged()));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    let host: BoundWebviewHost;
    host = createWebviewViewHost(webviewView, () => this.showPlaceholder(host));
    this.bindHost(host);
  }

  public resolveWebviewPanel(panel: vscode.WebviewPanel, replaceAfterReadyTimeout?: () => void | Promise<void>): void {
    this.surface = 'editor';
    this.bindHost(createWebviewPanelHost(panel, replaceAfterReadyTimeout));
  }

  public getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  public hasResolvedView(): boolean {
    return this.view !== undefined && !this.disposed;
  }

  public isReady(): boolean {
    return this.session.ready && !this.disposed;
  }

  public setSelectedOrg(username?: string): void {
    const next = typeof username === 'string' ? username.trim() || undefined : undefined;
    if (next !== this.selectedOrg) {
      this.bootstrapNeedsRefresh = true;
    }
    this.selectedOrg = next;
  }

  public async syncSelectedOrg(username?: string): Promise<void> {
    const next = typeof username === 'string' ? username.trim() || undefined : undefined;
    if (!next || next === this.selectedOrg) {
      return;
    }
    this.setSelectedOrg(next);
    if (!this.view || this.disposed) {
      return;
    }
    this.post({ type: 'customLogsOrgs', data: this.orgs, selected: next });
    await this.reload({ clearPage: true, refreshSources: false });
  }

  /** Re-detects the sources of the org (drops core's cached answers) and reloads the first page. */
  public async refresh(): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    await this.reload({ clearPage: false, refreshSources: true });
  }

  /** `sfdx-project.json` changed: re-resolve the sources against the new mapping and reload the page. */
  public async onProjectConfigChanged(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.view) {
      this.projectConfigPending = true;
      return;
    }
    await this.reload({ clearPage: false, refreshSources: false });
  }

  public getWebviewDiagnosticState(): WebviewProviderDiagnosticState {
    const diagnostic = this.sessionDiagnostic;
    return {
      surface: 'customLogs',
      hasHost: !!this.view,
      hostKind: this.surface === 'editor' ? 'editor' : 'panel',
      visible: diagnostic?.visible,
      ready: this.session.ready,
      disposed: this.disposed,
      contentMounted: diagnostic?.contentMounted ?? false,
      mountSequence: diagnostic?.generation ?? 0,
      mountTimerActive: diagnostic?.mountTimerActive ?? false,
      readyTimerActive: diagnostic?.readyTimerActive ?? false,
      needsReplayOnVisible: diagnostic?.needsReplay ?? true,
      snapshots: {
        loading: this.loadingState,
        hasOrgsSnapshot: this.hasOrgsSnapshot,
        orgCount: this.orgs.length,
        hasSourcesSnapshot: this.hasSourcesSnapshot,
        sourceCount: this.sources.length,
        hasPageSnapshot: this.hasPageSnapshot,
        rowCount: this.rows.length,
        hasMore: this.hasMore,
        hasError: this.errorMessage !== undefined,
        sessionEvent: diagnostic?.event,
        sessionGeneration: diagnostic?.generation,
        sessionRetryAttempt: diagnostic?.attempt,
        sessionDeliveryClassification: diagnostic?.classification
      }
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.view = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.session.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  private selectedSource(): CustomLogSourceView | undefined {
    return this.sources.find(source => source.id === this.selectedSourceId && source.state === 'ready');
  }

  private async handleMessage(message: CustomLogsFromWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'customLogsSelectOrg':
        await this.selectOrg(message.target);
        return;
      case 'customLogsSelectSource':
        await this.selectSource(message.sourceId);
        return;
      case 'customLogsSetFilter':
        await this.setFilter(message.filter);
        return;
      case 'customLogsRefresh':
        await this.reload({ clearPage: false, refreshSources: true });
        return;
      case 'customLogsLoadMore':
        await this.loadMore();
        return;
      case 'customLogsOpenLog':
        await this.openLog(message.logId);
        return;
      case 'customLogsOpenPayload':
        await this.openPayload(message.logId);
        return;
      case 'customLogsSetPayloadColumns':
        await this.setPayloadColumns(message.added);
        return;
      case 'customLogsOpenConfig':
        await vscode.commands.executeCommand(CUSTOM_LOGS_COMMANDS.configure);
        return;
      case 'customLogsOpenEditor':
        await vscode.commands.executeCommand(CUSTOM_LOGS_COMMANDS.openEditor);
        return;
      case 'customLogsReady':
        return;
    }
  }

  private async selectOrg(target: string): Promise<void> {
    const org = this.orgs.find(candidate => candidate.username === target || candidate.alias === target);
    if (!org) {
      logWarn('Custom Logs: ignored selectOrg for an org that was not listed');
      return;
    }
    if (org.username === this.selectedOrg) {
      return;
    }
    this.selectedOrg = org.username;
    this.post({ type: 'customLogsOrgs', data: this.orgs, selected: org.username });
    await this.reload({ clearPage: true, refreshSources: false });
  }

  private async selectSource(sourceId: string): Promise<void> {
    const source = this.sources.find(candidate => candidate.id === sourceId && candidate.state === 'ready');
    if (!source) {
      logWarn('Custom Logs: ignored selectSource for a source that is not ready');
      return;
    }
    this.preferredSourceId = source.id;
    if (source.id === this.selectedSourceId) {
      return;
    }
    await this.run(async (signal, current) => {
      this.clearPage();
      this.applySources(this.sources, this.issues, source.id);
      await this.fetchPage('replace', signal, current);
    });
  }

  private async setFilter(filter: CustomLogsFilterView): Promise<void> {
    this.post({ type: 'customLogsFilter', value: restrictFilter(filter, this.selectedSource()) });
    await this.run((signal, current) => this.fetchPage('replace', signal, current));
  }

  private async loadMore(): Promise<void> {
    if (this.cursor === null || this.requestController) {
      return;
    }
    await this.run((signal, current) => this.fetchPage('append', signal, current));
  }

  private async setPayloadColumns(added: string[]): Promise<void> {
    const source = this.selectedSource();
    const level = source ? levelOf(source) : undefined;
    if (!source || !level || !source.payload[level]) {
      logWarn('Custom Logs: ignored setPayloadColumns for a source that maps no payload');
      return;
    }
    await this.payloadColumnsStore.write(source.id, level, added);
    const value = this.columnsFor(source);
    this.post({ type: 'customLogsPayloadColumns', value });
    safeSendEvent('customLogs.payloadColumns', { outcome: 'ok', level }, { count: value.added.length });
  }

  private async openLog(logId: string): Promise<void> {
    const source = this.selectedSource();
    if (!source || !this.rows.some(row => row.id === logId)) {
      logWarn('Custom Logs: ignored openLog for a record that is not listed');
      return;
    }
    await CustomLogViewerPanel.show({ targetOrg: this.selectedOrg, sourceId: source.id, logId });
  }

  private async openPayload(logId: string): Promise<void> {
    const source = this.selectedSource();
    const row = this.rows.find(candidate => candidate.id === logId);
    if (!source || !row) {
      logWarn('Custom Logs: ignored openPayload for a record that is not listed');
      return;
    }
    const startedAt = Date.now();
    try {
      const projectDir = await findCustomLogsProjectDir();
      const scope = { targetOrg: this.selectedOrg, projectDir, source: source.id };
      const value =
        levelOf(source) === 'entry'
          ? (await runtimeClient.customLogEntry({ ...scope, entryId: logId })).rawPayload
          : ((await runtimeClient.customLogGet({ ...scope, logId, limit: 1 })).logPayload ?? {
              state: 'unmapped' as const
            });
      if (value.state !== 'value') {
        void vscode.window.showInformationMessage(this.payloadStateMessage(value.state));
        return;
      }
      await openCustomLogDocument({
        name: `${localize('customLogs.field.payload', 'Payload')} - ${row.title ?? row.id}`,
        text: value.value,
        format: value.format
      });
      safeSendEvent(
        'customLogs.openField',
        { outcome: 'ok', kind: 'payload', format: value.format },
        { durationMs: Date.now() - startedAt }
      );
    } catch (error) {
      logWarn('Custom Logs: openPayload failed ->', getErrorMessage(error));
      this.post({ type: 'customLogsError', message: getErrorMessage(error) });
      safeSendEvent('customLogs.openField', { outcome: 'error', code: getTelemetryErrorCode(error) });
    }
  }

  private payloadStateMessage(state: 'empty' | 'hidden' | 'unmapped'): string {
    switch (state) {
      case 'empty':
        return localize('customLogs.payload.empty', 'This record has no payload.');
      case 'hidden':
        return localize('customLogs.payload.hidden', 'You do not have permission to read this payload.');
      case 'unmapped':
        return localize('customLogs.payload.unmapped', 'This source does not map a payload.');
    }
  }

  private columnsFor(source: CustomLogSourceView | undefined): CustomLogPayloadColumnsView {
    if (!source) {
      return { defaults: [], added: [] };
    }
    const level = levelOf(source);
    return this.payloadColumnsStore.read(source.id, level, source.payload[level]?.columns ?? []);
  }

  private clearPage(): void {
    this.cursor = null;
    this.post({ type: 'customLogsPage', mode: 'replace', columns: [], rows: [], payloadFields: [], hasMore: false });
  }

  /** The one place a request starts: it supersedes the one in flight, owns the loading flag and turns failures into the banner. */
  private async run(work: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    const current = () => this.requestController === controller && !this.disposed;
    this.post({ type: 'customLogsLoading', value: true });
    if (this.errorMessage !== undefined) {
      this.post({ type: 'customLogsError', message: undefined });
    }
    try {
      await work(controller.signal, current);
    } catch (error) {
      if (current() && !isAbortLike(error)) {
        const message = getErrorMessage(error);
        logWarn('Custom Logs: request failed ->', message);
        this.bootstrapNeedsRefresh = true;
        this.post({ type: 'customLogsError', message });
      }
    } finally {
      if (current()) {
        this.requestController = undefined;
        this.post({ type: 'customLogsLoading', value: false });
      }
    }
  }

  private async reload(options: { clearPage: boolean; refreshSources: boolean }): Promise<void> {
    this.projectConfigPending = false;
    await this.run(async (signal, current) => {
      if (options.clearPage) {
        this.clearPage();
      }
      if (!this.hasOrgsSnapshot || this.bootstrapNeedsRefresh) {
        await this.loadOrgs(signal);
        if (!current()) {
          return;
        }
      }
      if (!this.selectedOrg) {
        return;
      }
      const previousSourceId = this.selectedSourceId;
      await this.loadSources(options.refreshSources, signal, current);
      if (!current()) {
        return;
      }
      if (this.selectedSourceId !== previousSourceId) {
        this.clearPage();
      }
      await this.fetchPage('replace', signal, current);
      if (current()) {
        this.bootstrapNeedsRefresh = false;
      }
    });
  }

  private async loadOrgs(signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    try {
      const orgs = await runtimeClient.orgList({}, signal);
      const selected = pickSelectedOrg(orgs, this.selectedOrg);
      this.post({ type: 'customLogsOrgs', data: orgs, selected });
      safeSendEvent(
        'orgs.list',
        { outcome: 'ok', view: 'customLogs' },
        { durationMs: Date.now() - startedAt, count: orgs.length }
      );
    } catch (error) {
      if (!isAbortLike(error)) {
        this.post({ type: 'customLogsOrgs', data: [], selected: this.selectedOrg });
        safeSendEvent(
          'orgs.list',
          { outcome: 'error', view: 'customLogs', code: getTelemetryErrorCode(error) },
          { durationMs: Date.now() - startedAt }
        );
      }
      throw error;
    }
  }

  private async loadSources(refresh: boolean, signal: AbortSignal, current: () => boolean): Promise<void> {
    const startedAt = Date.now();
    const projectDir = await findCustomLogsProjectDir();
    try {
      const result = await runtimeClient.customLogSources({ targetOrg: this.selectedOrg, projectDir, refresh }, signal);
      if (!current()) {
        return;
      }
      this.applySources(
        result.sources,
        result.issues,
        pickSourceId(result.sources, this.preferredSourceId, result.defaultSourceId)
      );
      safeSendEvent(
        'customLogs.sources',
        {
          outcome: 'ok',
          hasConfig: String(result.sources.some(source => source.origin === 'config')),
          ready: String(result.sources.some(source => source.state === 'ready'))
        },
        { durationMs: Date.now() - startedAt, count: result.sources.length }
      );
    } catch (error) {
      if (!isAbortLike(error)) {
        safeSendEvent(
          'customLogs.sources',
          { outcome: 'error', code: getTelemetryErrorCode(error) },
          { durationMs: Date.now() - startedAt }
        );
      }
      throw error;
    }
  }

  /** Publishes the sources with the selection, and the filter and JSON columns that depend on it. */
  private applySources(
    sources: CustomLogSourceView[],
    issues: CustomLogConfigIssueView[],
    selected: string | undefined
  ): void {
    this.post({ type: 'customLogsSources', data: sources, selected, issues });
    const source = this.selectedSource();
    this.post({ type: 'customLogsFilter', value: restrictFilter(this.filter, source) });
    this.post({ type: 'customLogsPayloadColumns', value: this.columnsFor(source) });
  }

  private async fetchPage(mode: 'replace' | 'append', signal: AbortSignal, current: () => boolean): Promise<void> {
    const source = this.selectedSource();
    if (!source) {
      this.clearPage();
      return;
    }
    const startedAt = Date.now();
    try {
      const projectDir = await findCustomLogsProjectDir();
      const page = await runtimeClient.customLogList(
        {
          targetOrg: this.selectedOrg,
          projectDir,
          source: source.id,
          filter: this.filter,
          limit: PAGE_SIZE,
          ...(mode === 'append' && this.cursor !== null ? { cursor: this.cursor } : {})
        },
        signal
      );
      if (!current()) {
        return;
      }
      this.cursor = page.nextCursor;
      this.post({
        type: 'customLogsPage',
        mode,
        columns: page.columns,
        rows: page.rows,
        payloadFields: page.payloadFields,
        hasMore: page.nextCursor !== null
      });
      if (mode === 'replace') {
        safeSendEvent(
          'customLogs.refresh',
          { outcome: 'ok' },
          { durationMs: Date.now() - startedAt, count: page.rows.length }
        );
      }
    } catch (error) {
      if (mode === 'replace' && !isAbortLike(error)) {
        safeSendEvent(
          'customLogs.refresh',
          { outcome: 'error', code: getTelemetryErrorCode(error) },
          { durationMs: Date.now() - startedAt }
        );
      }
      throw error;
    }
  }

  private async bootstrapWebview(): Promise<void> {
    if (this.hasOrgsSnapshot && this.hasSourcesSnapshot && !this.bootstrapNeedsRefresh && !this.projectConfigPending) {
      return;
    }
    await this.reload({ clearPage: false, refreshSources: false });
  }

  private getReplaySnapshot(): readonly CustomLogsToWebviewMessage[] {
    const snapshot: CustomLogsToWebviewMessage[] = [
      { type: 'customLogsInit', locale: vscode.env.language, surface: this.surface }
    ];
    if (this.hasOrgsSnapshot) {
      snapshot.push({ type: 'customLogsOrgs', data: this.orgs, selected: this.selectedOrg });
    }
    if (this.hasSourcesSnapshot) {
      snapshot.push({
        type: 'customLogsSources',
        data: this.sources,
        selected: this.selectedSourceId,
        issues: this.issues
      });
    }
    snapshot.push(
      { type: 'customLogsFilter', value: this.filter },
      { type: 'customLogsPayloadColumns', value: this.payloadColumns }
    );
    if (this.hasPageSnapshot) {
      snapshot.push({
        type: 'customLogsPage',
        mode: 'replace',
        columns: this.columns,
        rows: this.rows,
        payloadFields: this.payloadFields,
        hasMore: this.hasMore
      });
    }
    snapshot.push(
      { type: 'customLogsLoading', value: this.loadingState },
      { type: 'customLogsError', message: this.errorMessage }
    );
    return snapshot;
  }

  private post(message: CustomLogsToWebviewMessage): void {
    switch (message.type) {
      case 'customLogsOrgs':
        this.hasOrgsSnapshot = true;
        this.orgs = [...message.data];
        this.selectedOrg = message.selected;
        break;
      case 'customLogsSources':
        this.hasSourcesSnapshot = true;
        this.sources = [...message.data];
        this.issues = [...message.issues];
        this.selectedSourceId = message.selected;
        break;
      case 'customLogsFilter':
        this.filter = message.value;
        break;
      case 'customLogsPayloadColumns':
        this.payloadColumns = message.value;
        break;
      case 'customLogsLoading':
        this.loadingState = message.value;
        break;
      case 'customLogsPage':
        this.hasPageSnapshot = true;
        this.columns = message.columns;
        this.hasMore = message.hasMore;
        if (message.mode === 'replace') {
          this.rows = message.rows;
          this.payloadFields = message.payloadFields;
        } else {
          this.rows = [...this.rows, ...message.rows];
          this.payloadFields = mergePayloadFields(this.payloadFields, message.payloadFields);
        }
        break;
      case 'customLogsError':
        this.errorMessage = message.message;
        break;
      case 'customLogsInit':
        break;
    }
    void this.session.deliver(message, 'replayable');
  }

  private getHtmlForWebview(webview: vscode.Webview, mountSequence?: number): string {
    return buildWebviewHtml(
      webview,
      this.context.extensionUri,
      'customLogs.js',
      localize('customLogs.view.name', 'Electivus Custom Logs'),
      { mountSequence }
    );
  }

  private getPlaceholderHtml(): string {
    const title = localize('customLogs.view.name', 'Electivus Custom Logs')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
  </head>
  <body></body>
</html>`;
  }

  private showPlaceholder(host: BoundWebviewHost): void {
    host.webview.html = this.getPlaceholderHtml();
    recordWebviewEvent({
      surface: 'customLogs',
      event: 'placeholder',
      visible: host.visible,
      ready: this.session.ready,
      contentMounted: false
    });
  }

  private validateInbound(message: unknown): WebviewSessionInbound<CustomLogsFromWebviewMessage> | undefined {
    const parsed = parseCustomLogsFromWebviewMessage(message);
    if (!parsed) {
      logWarn('Custom Logs: ignored invalid webview message');
      return undefined;
    }
    return parsed.type === 'customLogsReady'
      ? { kind: 'ready', ...(parsed.mountSequence !== undefined ? { generation: parsed.mountSequence } : {}) }
      : { kind: 'message', message: parsed };
  }

  private handleSessionDiagnostic(diagnostic: WebviewSessionDiagnostic): void {
    this.sessionDiagnostic = diagnostic;
    if (diagnostic.event === 'ready') {
      logInfo('Custom Logs webview ready.');
    }
    recordWebviewEvent({
      surface: 'customLogs',
      event: diagnostic.event,
      mountSequence: diagnostic.generation,
      visible: diagnostic.visible,
      ready: diagnostic.ready,
      contentMounted: diagnostic.contentMounted,
      details: {
        ...(diagnostic.classification ? { classification: diagnostic.classification } : {}),
        ...(diagnostic.attempt !== undefined ? { attempt: diagnostic.attempt } : {}),
        ...(diagnostic.callback ? { callback: diagnostic.callback } : {})
      }
    });
  }

  private handleSessionDetach(reason: WebviewSessionDetachReason): void {
    this.view = undefined;
    if ((reason === 'hostDisposed' || reason === 'explicit') && this.requestController) {
      this.requestController.abort();
      this.requestController = undefined;
      this.loadingState = false;
      this.bootstrapNeedsRefresh = true;
    }
    logInfo(`Custom Logs webview detached (${reason}).`);
  }

  private bindHost(host: BoundWebviewHost): void {
    if (this.disposed) {
      return;
    }
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    this.showPlaceholder(host);
    this.session.bind(host);
    this.view = host;
    logInfo('Custom Logs webview resolved.');
  }
}
