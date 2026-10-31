import * as vscode from 'vscode';
import { localize } from '../host/utils/localize';
import { logInfo, logWarn } from '../host/utils/logger';
import { recordInboundMessage } from '../host/utils/responsiveness';
import { isAbortError } from '../host/utils/abort';
import { getErrorMessage } from '../host/utils/error';
import { OrgManager } from '../host/utils/orgManager';
import { pickSelectedOrg } from '../host/utils/orgs';
import { buildWebviewHtml } from '../host/utils/webviewHtml';
import { findCustomLogsProjectDir, onSfdxProjectFileChanged } from '../host/utils/workspace';
import { openCustomLogDocument } from '../host/utils/customLogDocuments';
import { CustomLogViewerPanel } from '../panel/CustomLogViewerPanel';
import { runtimeClient, type CustomLogCaptureUpdateView } from '../runtime/runtimeClient';
import { safeSendEvent } from '../shared/telemetry';
import { getTelemetryErrorCode } from '../shared/telemetryErrorCodes';
import type { WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';
import {
  parseCustomLogsFromWebviewMessage,
  type CustomLogsFromWebviewMessage,
  type CustomLogsToWebviewMessage
} from '../shared/customLogsMessages';
import {
  initialCustomLogsView,
  reduceCustomLogsView,
  replayCustomLogsView,
  type CustomLogsViewState
} from '../shared/customLogsState';
import {
  CUSTOM_LOGS_LIVE_ROW_CAP,
  mergePayloadFields,
  type CustomLogCaptureChoice,
  type CustomLogConfigIssueView,
  type CustomLogLiveRowsView,
  type CustomLogPayloadColumnsView,
  type CustomLogRow,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from '../shared/customLogsTypes';
import { createWebviewPanelHost, createWebviewViewHost, type BoundWebviewHost } from './webviewHost';
import { createWebviewSession, type WebviewSession, type WebviewSessionDetachReason } from './webviewSession';
import { createWebviewSurface } from './webviewSurface';
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

/** The level whose payload columns the list shows; a new shape fails `satisfies` here. */
const PAYLOAD_LEVEL = {
  transactions: 'transaction',
  entries: 'entry',
  events: 'entry'
} as const satisfies Record<CustomLogSourceView['shape'], CustomLogPayloadLevel>;

/**
 * Whether the panel captures a shape while it is open. Capturing spends the org's delivery allocation, so a shape
 * that captures is never picked as a fallback: the user opens it.
 */
const SHAPE_CAPTURES = {
  transactions: false,
  entries: false,
  events: true
} as const satisfies Record<CustomLogSourceView['shape'], boolean>;

/** What the user asked of capture for one org and source; a new selection starts over with all of it. */
type CaptureIntent = {
  selection: string | undefined;
  /** False after Stop, until Start or another org or source is picked. */
  wanted: boolean;
  /** The answer to the first-use prompt, spent by the next start. */
  initial: CustomLogCaptureChoice | undefined;
  /** Page 1 was reloaded once for this selection's columns. */
  columnsReloaded: boolean;
};

const newIntent = (selection: string | undefined): CaptureIntent => ({
  selection,
  wanted: true,
  initial: undefined,
  columnsReloaded: false
});

/** The capture running for the screen. `key` names what it was started for, `ended` that its promise settled. */
type CaptureRun = { controller: AbortController; key: string; ended: boolean };

/** The messages that can change what a capture is for, so `post` checks the running one after them. */
const RETARGETING = new Set<CustomLogsToWebviewMessage['type']>([
  'customLogsOrgs',
  'customLogsSources',
  'customLogsFilter'
]);

/** Core takes the level and user of the filter; `since` only bounds the list. */
function captureFilterOf(filter: CustomLogsFilterView): Pick<CustomLogsFilterView, 'minLevel' | 'user'> {
  return { ...(filter.minLevel ? { minLevel: filter.minLevel } : {}), ...(filter.user ? { user: filter.user } : {}) };
}

function captureCodeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : 'CUSTOM_LOG_CAPTURE_FAILED';
}

function levelOf(source: CustomLogSourceView): CustomLogPayloadLevel {
  return PAYLOAD_LEVEL[source.shape];
}

/**
 * The user's choice while it is still ready, else the source on screen (so a mapping edit that adds one
 * does not move the list), else the only ready source core names, else the first ready record source, else
 * the first ready source. A project with only event sources has nothing else to open, and the Source picker
 * appears with two ready sources, so a lone event source left unselected could never be chosen. Selecting
 * it buys no replay: the first-use choice does.
 */
function pickSourceId(
  sources: readonly CustomLogSourceView[],
  wanted: ReadonlyArray<string | undefined>,
  defaultSourceId: string | undefined
): string | undefined {
  const ready = (id: string | undefined) => sources.find(source => source.id === id && source.state === 'ready')?.id;
  return (
    wanted.map(ready).find(id => id !== undefined) ??
    ready(defaultSourceId) ??
    sources.find(source => source.state === 'ready' && !SHAPE_CAPTURES[source.shape])?.id ??
    sources.find(source => source.state === 'ready')?.id
  );
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

export class CustomLogsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'electivus.apexLogViewer.customLogsView';
  private view?: { webview: vscode.Webview };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session: WebviewSession<CustomLogsToWebviewMessage, BoundWebviewHost>;
  private readonly payloadColumnsStore: PayloadColumnsStore;
  private readonly orgManager: OrgManager;
  private readonly webviewSurface = createWebviewSurface({
    surface: 'customLogs',
    label: 'Custom Logs',
    title: () => localize('customLogs.view.name', 'Electivus Custom Logs'),
    readyType: 'customLogsReady',
    parseInbound: parseCustomLogsFromWebviewMessage,
    log: { info: logInfo, warn: logWarn }
  });
  private disposed = false;
  private surface: 'view' | 'editor' = 'view';
  private requestController: AbortController | undefined;
  private bootstrapNeedsRefresh = true;
  private projectConfigPending = false;

  // The authoritative replay snapshot: `post` folds every outbound message into it before it delivers.
  private state: CustomLogsViewState = initialCustomLogsView;
  private selectedOrg: string | undefined;
  private preferredSourceId: string | undefined;
  private cursor: string | null = null;
  private captureIntent = newIntent(undefined);
  private capture: CaptureRun | undefined;
  /**
   * Live batches that arrive while a replace page is read. That page's store snapshot may predate them and the
   * replace drops every merged row, while capture sends each batch once, so they are merged again after it.
   */
  private liveDuringReplace: CustomLogLiveRowsView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.payloadColumnsStore = createPayloadColumnsStore(context.workspaceState);
    this.orgManager = new OrgManager(context);
    this.session = createWebviewSession({
      mount: (host, generation) => {
        host.webview.html = this.getHtmlForWebview(host.webview, generation);
        logInfo('Custom Logs webview mounted.');
      },
      getReplaySnapshot: () => this.getReplaySnapshot(),
      onInboundReceived: message => recordInboundMessage('customLogs', message),
      validateInbound: message => this.webviewSurface.validateInbound(message),
      onDetach: reason => this.handleSessionDetach(reason),
      onMessage: message => this.handleMessage(message),
      onReady: () => this.bootstrapWebview(),
      onDiagnostic: diagnostic => this.webviewSurface.handleSessionDiagnostic(diagnostic)
    });
    this.disposables.push(onSfdxProjectFileChanged(() => void this.onProjectConfigChanged()));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    let host: BoundWebviewHost;
    host = createWebviewViewHost(webviewView, () => this.webviewSurface.showPlaceholder(host, this.session.ready));
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
    this.post({ type: 'customLogsOrgs', data: this.state.orgs?.data ?? [], selected: next });
    await this.reload({ clearPage: true, refreshSources: false });
  }

  /** Re-detects the sources of the org (drops core's cached answers) and reloads the first page. */
  public async refresh(): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    await this.reload({ clearPage: false, refreshSources: true });
  }

  /**
   * `sfdx-project.json` changed: resolve the sources against the new mapping and reload the page. Core keys
   * its detection memo by the mapping, so a save does not drop what it already learned about the org. A
   * capture keeps the mapping it was started with, so it ends here and the page load starts one on the new
   * mapping, even when the source id did not change.
   */
  public async onProjectConfigChanged(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.stopCapture();
    if (!this.view) {
      this.projectConfigPending = true;
      return;
    }
    await this.reload({ clearPage: false, refreshSources: false });
  }

  public getWebviewDiagnosticState(): WebviewProviderDiagnosticState {
    return this.webviewSurface.diagnosticState({
      session: this.session,
      hasHost: !!this.view,
      hostKind: this.surface === 'editor' ? 'editor' : 'panel',
      disposed: this.disposed,
      snapshots: {
        loading: this.state.loading,
        hasOrgsSnapshot: this.state.orgs !== undefined,
        orgCount: this.state.orgs?.data.length ?? 0,
        hasSourcesSnapshot: this.state.sources !== undefined,
        sourceCount: this.sources.length,
        hasPageSnapshot: this.state.page !== undefined,
        rowCount: this.rows.length,
        hasMore: this.state.page?.hasMore ?? false,
        hasError: this.state.error !== undefined,
        captureState: this.state.capture?.capture.state
      }
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.view = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.stopCapture();
    this.session.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  private get sources(): CustomLogSourceView[] {
    return this.state.sources?.data ?? [];
  }

  private get rows(): CustomLogRow[] {
    return this.state.page?.rows ?? [];
  }

  private selectedSource(): CustomLogSourceView | undefined {
    return this.sources.find(source => source.id === this.state.sources?.selected && source.state === 'ready');
  }

  private async handleMessage(message: CustomLogsFromWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'customLogsSelectOrg':
        await this.selectOrg(message.target);
        return;
      case 'customLogsSelectSource':
        await this.selectSource(message.sourceId, message.filter);
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
      case 'customLogsCapture':
        await this.changeCapture(message);
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
    const org = this.state.orgs?.data.find(candidate => candidate.username === target || candidate.alias === target);
    if (!org) {
      logWarn('Custom Logs: ignored selectOrg for an org that was not listed');
      return;
    }
    if (org.username === this.selectedOrg) {
      return;
    }
    this.selectedOrg = org.username;
    this.post({ type: 'customLogsOrgs', data: this.state.orgs?.data ?? [], selected: org.username });
    await this.reload({ clearPage: true, refreshSources: false });
  }

  private async selectSource(sourceId: string, filter: CustomLogsFilterView | undefined): Promise<void> {
    const source = this.sources.find(candidate => candidate.id === sourceId && candidate.state === 'ready');
    if (!source) {
      logWarn('Custom Logs: ignored selectSource for a source that is not ready');
      return;
    }
    this.preferredSourceId = source.id;
    if (source.id === this.state.sources?.selected) {
      if (filter) {
        await this.setFilter(filter);
      }
      return;
    }
    await this.run(async (signal, current) => {
      this.clearPage();
      this.applySources(this.sources, this.state.sources?.issues ?? [], source.id, filter);
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

  /**
   * The Stop and Start buttons of the capture strip. Start answers the first-use prompt with `initial`, or
   * restarts a capture that ended; Stop keeps the user's choice until another org or source is picked.
   */
  private async changeCapture(
    message: Extract<CustomLogsFromWebviewMessage, { type: 'customLogsCapture' }>
  ): Promise<void> {
    const source = this.selectedSource();
    if (!source || !SHAPE_CAPTURES[source.shape]) {
      logWarn('Custom Logs: ignored a capture action for a source that does not capture');
      return;
    }
    if (message.action === 'stop') {
      this.captureIntent = { ...this.captureIntent, wanted: false };
      this.stopCapture();
      const view = this.state.capture;
      if (view) {
        this.post({
          type: 'customLogsCapture',
          value: { ...view, capture: { state: 'stopped', outcome: 'aborted' }, wanted: false }
        });
      }
      return;
    }
    this.captureIntent = { ...this.captureIntent, wanted: true, initial: message.initial };
    this.ensureCapture(await findCustomLogsProjectDir(), 'start');
  }

  private captureSelection(): string {
    return JSON.stringify([this.selectedOrg, this.state.sources?.selected]);
  }

  /** What a capture is started for: the org and source on screen, and the part of the filter core applies to live rows. */
  private captureKey(): string {
    return JSON.stringify([this.captureSelection(), captureFilterOf(this.state.filter)]);
  }

  /**
   * Runs after every message that moves the org, the source or the filter. A capture belongs to the screen it
   * started for, so it ends when that changes and the next page load starts the one that fits. A new org or
   * source also starts the user's choices over and takes the strip down until its own capture reports.
   */
  private retarget(): void {
    const selection = this.captureSelection();
    if (selection !== this.captureIntent.selection) {
      this.captureIntent = newIntent(selection);
      if (this.state.capture) {
        this.post({ type: 'customLogsCapture', value: undefined });
      }
    }
    if (this.capture && this.capture.key !== this.captureKey()) {
      this.stopCapture();
    }
  }

  /**
   * Starts a follow capture for the selected event source unless one already serves this screen. The page
   * load starts it (an empty `notCaptured` page counts) and never restarts one that ended; the Start button
   * restarts an ended one. `initial: 'none'` keeps the first and largest replay of an org behind the user's click.
   */
  private ensureCapture(projectDir: string | undefined, trigger: 'page' | 'start'): void {
    const source = this.selectedSource();
    if (!source || !SHAPE_CAPTURES[source.shape] || !this.captureIntent.wanted || this.disposed) {
      return;
    }
    if (this.capture && (trigger === 'page' || !this.capture.ended)) {
      return;
    }
    const run: CaptureRun = { controller: new AbortController(), key: this.captureKey(), ended: false };
    this.capture = run;
    const initial = this.captureIntent.initial ?? 'none';
    this.captureIntent = { ...this.captureIntent, initial: undefined };
    void runtimeClient
      .customLogCapture(
        {
          targetOrg: this.selectedOrg,
          projectDir,
          source: source.id,
          follow: true,
          initial,
          filter: captureFilterOf(this.state.filter)
        },
        { signal: run.controller.signal, onUpdate: update => this.onCaptureUpdate(run, update) }
      )
      .then(
        () => {
          run.ended = true;
        },
        error => this.failCapture(run, error)
      );
  }

  private onCaptureUpdate(run: CaptureRun, update: CustomLogCaptureUpdateView): void {
    if (this.capture !== run) {
      return;
    }
    this.post({
      type: 'customLogsCapture',
      value: {
        capture: update.capture,
        store: update.store,
        wanted: this.captureIntent.wanted,
        ...(update.allowance ? { allowance: update.allowance } : {})
      }
    });
    if (update.rows.length === 0) {
      return;
    }
    const missed = this.liveDuringReplace;
    if (missed) {
      missed.rows.push(...update.rows);
      missed.payloadFields = mergePayloadFields(missed.payloadFields, update.payloadFields);
    }
    this.post({ type: 'customLogsLiveRows', rows: update.rows, payloadFields: update.payloadFields });
    this.reloadAfterLiveRows();
  }

  /**
   * Live rows never set columns and the reducer never evicts, so the newest page is read again (the way
   * Refresh does) when the first stored batch finds the page without columns, once per selection, and when
   * the page outgrows the row cap. A source that maps no columns reloads once too, not on every flush.
   */
  private reloadAfterLiveRows(): void {
    const page = this.state.page;
    const needsColumns = !this.captureIntent.columnsReloaded && (page?.columns.length ?? 0) === 0;
    if (!needsColumns && (page?.rows.length ?? 0) <= CUSTOM_LOGS_LIVE_ROW_CAP) {
      return;
    }
    if (needsColumns) {
      this.captureIntent = { ...this.captureIntent, columnsReloaded: true };
    }
    void this.run((signal, current) => this.fetchPage('replace', signal, current));
  }

  /** Core reports a run's own failure in an update; one that stops the run before it starts has none, so it shows here. */
  private failCapture(run: CaptureRun, error: unknown): void {
    run.ended = true;
    if (this.capture !== run || isAbortError(error)) {
      return;
    }
    const message = getErrorMessage(error);
    logWarn('Custom Logs: capture failed ->', message);
    const view = this.state.capture;
    if (!view) {
      this.post({ type: 'customLogsError', message });
      return;
    }
    this.post({
      type: 'customLogsCapture',
      value: {
        ...view,
        capture: { state: 'failed', code: captureCodeOf(error), message },
        wanted: this.captureIntent.wanted
      }
    });
  }

  private stopCapture(): void {
    this.capture?.controller.abort();
    this.capture = undefined;
  }

  private async openLog(logId: string): Promise<void> {
    const source = this.selectedSource();
    if (!source || !this.rows.some(row => row.id === logId)) {
      logWarn('Custom Logs: ignored openLog for a record that is not listed');
      return;
    }
    await CustomLogViewerPanel.show({
      targetOrg: this.selectedOrg,
      sourceId: source.id,
      logId,
      payloadDefaults: source.payload.entry?.columns ?? []
    });
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
    if (this.state.error !== undefined) {
      this.post({ type: 'customLogsError', message: undefined });
    }
    try {
      await work(controller.signal, current);
    } catch (error) {
      if (current() && !isAbortError(error)) {
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
      if (!this.state.orgs || this.bootstrapNeedsRefresh) {
        await this.loadOrgs(signal);
        if (!current()) {
          return;
        }
      }
      if (!this.selectedOrg) {
        return;
      }
      const previousSourceId = this.state.sources?.selected;
      await this.loadSources(options.refreshSources, signal, current);
      if (!current()) {
        return;
      }
      if (this.state.sources?.selected !== previousSourceId) {
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
      // The workspace's target-org wins over the CLI's global default, as in the Logs view.
      await this.orgManager.ensureProjectDefaultSelected(orgs);
      const selected = pickSelectedOrg(orgs, this.selectedOrg ?? this.orgManager.getSelectedOrg());
      this.post({ type: 'customLogsOrgs', data: orgs, selected });
      safeSendEvent(
        'orgs.list',
        { outcome: 'ok', view: 'customLogs' },
        { durationMs: Date.now() - startedAt, count: orgs.length }
      );
    } catch (error) {
      if (!isAbortError(error)) {
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
        pickSourceId(result.sources, [this.preferredSourceId, this.state.sources?.selected], result.defaultSourceId)
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
      if (!isAbortError(error)) {
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
    selected: string | undefined,
    filter: CustomLogsFilterView = this.state.filter
  ): void {
    this.post({ type: 'customLogsSources', data: sources, selected, issues });
    const source = this.selectedSource();
    this.post({ type: 'customLogsFilter', value: restrictFilter(filter, source) });
    this.post({ type: 'customLogsPayloadColumns', value: this.columnsFor(source) });
  }

  /** A replace page starts a new query, so the cursor of the last one no longer belongs to the filter. */
  private stopPaging(): void {
    this.cursor = null;
    if (this.state.page?.hasMore) {
      this.post({
        type: 'customLogsPage',
        mode: 'append',
        columns: this.state.page.columns,
        rows: [],
        payloadFields: [],
        hasMore: false
      });
    }
  }

  private async fetchPage(mode: 'replace' | 'append', signal: AbortSignal, current: () => boolean): Promise<void> {
    const source = this.selectedSource();
    if (!source) {
      this.clearPage();
      return;
    }
    if (mode === 'replace') {
      this.stopPaging();
    }
    const missed: CustomLogLiveRowsView | undefined = mode === 'replace' ? { rows: [], payloadFields: [] } : undefined;
    if (missed) {
      this.liveDuringReplace = missed;
    }
    const startedAt = Date.now();
    try {
      const projectDir = await findCustomLogsProjectDir();
      const page = await runtimeClient.customLogList(
        {
          targetOrg: this.selectedOrg,
          projectDir,
          source: source.id,
          filter: this.state.filter,
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
      if (missed && missed.rows.length > 0) {
        this.post({ type: 'customLogsLiveRows', rows: missed.rows, payloadFields: missed.payloadFields });
      }
      if (mode === 'replace') {
        safeSendEvent(
          'customLogs.refresh',
          { outcome: 'ok' },
          { durationMs: Date.now() - startedAt, count: page.rows.length }
        );
        this.ensureCapture(projectDir, 'page');
      }
    } catch (error) {
      if (mode === 'replace' && !isAbortError(error)) {
        safeSendEvent(
          'customLogs.refresh',
          { outcome: 'error', code: getTelemetryErrorCode(error) },
          { durationMs: Date.now() - startedAt }
        );
      }
      throw error;
    } finally {
      if (missed && this.liveDuringReplace === missed) {
        this.liveDuringReplace = undefined;
      }
    }
  }

  private async bootstrapWebview(): Promise<void> {
    if (this.state.orgs && this.state.sources && !this.bootstrapNeedsRefresh && !this.projectConfigPending) {
      return;
    }
    await this.reload({ clearPage: false, refreshSources: false });
  }

  private getReplaySnapshot(): readonly CustomLogsToWebviewMessage[] {
    let state = reduceCustomLogsView(this.state, {
      type: 'customLogsInit',
      locale: vscode.env.language,
      surface: this.surface
    });
    if (state.orgs) {
      state = reduceCustomLogsView(state, {
        type: 'customLogsOrgs',
        data: state.orgs.data,
        selected: this.selectedOrg
      });
    }
    return replayCustomLogsView(state);
  }

  private post(message: CustomLogsToWebviewMessage): void {
    this.state = reduceCustomLogsView(this.state, message);
    if (message.type === 'customLogsOrgs') {
      this.selectedOrg = message.selected;
    }
    void this.session.deliver(message, 'replayable');
    if (RETARGETING.has(message.type)) {
      this.retarget();
    }
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

  private handleSessionDetach(reason: WebviewSessionDetachReason): void {
    this.view = undefined;
    if (reason === 'hostDisposed' || reason === 'explicit') {
      // The next webview reloads and starts the capture again; until then its replay must not claim "Live".
      if (this.capture) {
        this.stopCapture();
        this.state = reduceCustomLogsView(this.state, { type: 'customLogsCapture', value: undefined });
        this.bootstrapNeedsRefresh = true;
      }
      if (this.requestController) {
        this.requestController.abort();
        this.requestController = undefined;
        this.state = reduceCustomLogsView(this.state, { type: 'customLogsLoading', value: false });
        this.bootstrapNeedsRefresh = true;
      }
    }
    logInfo(`Custom Logs webview detached (${reason}).`);
  }

  private bindHost(host: BoundWebviewHost): void {
    if (this.disposed) {
      return;
    }
    this.webviewSurface.bindHost(host, this.session, [vscode.Uri.joinPath(this.context.extensionUri, 'media')]);
    this.view = host;
  }
}
