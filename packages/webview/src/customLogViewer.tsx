import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  mergePayloadFields,
  type CustomLogApexLogLink,
  type CustomLogColumn,
  type CustomLogEntry,
  type CustomLogLevel,
  type CustomLogLongFieldView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceRef
} from '@alv/protocol/customLogsTypes';
import type {
  CustomLogViewerFromWebviewMessage,
  CustomLogViewerToWebviewMessage
} from '@alv/protocol/customLogViewerMessages';
import { getMessages } from './i18n';
import { CustomLogEntryDetail } from './components/custom-logs/CustomLogEntryDetail';
import { CustomLogEntryList } from './components/custom-logs/CustomLogEntryList';
import { CustomLogViewerHeader } from './components/custom-logs/CustomLogViewerHeader';
import { CustomLogViewerToolbar } from './components/custom-logs/CustomLogViewerToolbar';
import { CustomLogsFilterBar } from './components/custom-logs/CustomLogsFilterBar';
import { CustomLogsStatusBar } from './components/custom-logs/CustomLogsStatusBar';
import { usePayloadWorkbench } from './components/custom-logs/usePayloadWorkbench';
import { LoadingOverlay } from './components/LoadingOverlay';
import {
  buildEntryColumns,
  countLevels,
  countPresentDetails,
  countSystemEntries,
  entrySortValue,
  filterEntries
} from './utils/customLogs/entries';
import { describeParseError, type FilterSubmitResult } from './utils/customLogs/filterMessages';
import { parseFilterExpression } from './utils/customLogs/filterGrammar';
import { fillTemplate, formatCount } from './utils/customLogs/format';
import {
  guidedPayloadFields,
  payloadValueSuggestions,
  type GuidedField,
  type GuidedItem
} from './utils/customLogs/guidedFilter';
import { countPayloadStates, type DiscoveredField, type PayloadColumn } from './utils/customLogs/payloadRows';
import { detailDock, readPayloadUiState, useElementHeight, type PayloadUiState } from './utils/customLogs/uiState';
import type { VsCodeWebviewApi, MessageBus } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';

type ViewerError = 'log' | 'entries' | 'entry' | 'field' | 'apexLog';

type CustomLogViewerUiState = PayloadUiState & { showSystem: boolean };

const EMPTY_COLUMNS: CustomLogPayloadColumnsView = { defaults: [], added: [] };
const NO_LEVELS: ReadonlySet<CustomLogLevel> = new Set();

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) {
    next.add(value);
  }
  return next;
}

export interface CustomLogViewerAppProps {
  vscode?: VsCodeWebviewApi<CustomLogViewerFromWebviewMessage>;
  messageBus?: MessageBus;
  virtualListComponent?: React.ComponentProps<typeof CustomLogEntryList>['virtualListComponent'];
}

export function CustomLogViewerApp({
  vscode = getDefaultVsCodeApi<CustomLogViewerFromWebviewMessage>(),
  messageBus = getDefaultMessageBus(),
  virtualListComponent
}: CustomLogViewerAppProps = {}) {
  const [initialUiState] = useState<CustomLogViewerUiState>(() => {
    const saved = vscode.getState<{ showSystem?: boolean }>();
    return { ...readPayloadUiState(saved), showSystem: saved?.showSystem === true };
  });
  const [locale, setLocale] = useState('en');
  const [source, setSource] = useState<CustomLogSourceRef | undefined>(undefined);
  const [log, setLog] = useState<CustomLogRow | undefined>(undefined);
  const [logPayload, setLogPayload] = useState<CustomLogLongFieldView | undefined>(undefined);
  const [apexLog, setApexLog] = useState<CustomLogApexLogLink | undefined>(undefined);
  const [entryColumns, setEntryColumns] = useState<CustomLogColumn[]>([]);
  const [columnsView, setColumnsView] = useState<CustomLogPayloadColumnsView>(EMPTY_COLUMNS);
  const [entries, setEntries] = useState<CustomLogEntry[]>([]);
  const [payloadFields, setPayloadFields] = useState<CustomLogPayloadField[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [entryFields, setEntryFields] = useState<Record<string, CustomLogLongFieldView[]>>({});
  const [loading, setLoading] = useState<Record<'log' | 'entries' | 'entry', boolean>>({
    log: true,
    entries: true,
    entry: false
  });
  const [errors, setErrors] = useState<Partial<Record<ViewerError, string>>>({});
  const [search, setSearch] = useState('');
  const [levels, setLevels] = useState<ReadonlySet<CustomLogLevel>>(NO_LEVELS);
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set());
  const [showSystem, setShowSystem] = useState(initialUiState.showSystem);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [rootRef, rootHeight] = useElementHeight<HTMLDivElement>();

  const t = getMessages(locale).customLogs;

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage({ type: 'customLogViewerReady' });
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as CustomLogViewerToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      switch (msg.type) {
        case 'customLogViewerInit':
          setLocale(msg.locale);
          setSource(msg.source);
          setLog(msg.log);
          setLogPayload(msg.logPayload);
          setEntryColumns(msg.entryColumns || []);
          setColumnsView(msg.payloadColumns ?? EMPTY_COLUMNS);
          setApexLog(msg.apexLog);
          setLoading(previous => ({ ...previous, log: false }));
          setErrors(previous => ({ ...previous, log: undefined, apexLog: undefined }));
          break;
        case 'customLogViewerEntries':
          if (msg.mode === 'replace') {
            setEntries(msg.entries || []);
            setPayloadFields(msg.payloadFields || []);
            setEntryFields({});
          } else {
            setEntries(previous => [...previous, ...(msg.entries || [])]);
            setPayloadFields(previous => mergePayloadFields(previous, msg.payloadFields || []));
          }
          setHasMore(!!msg.hasMore);
          setLoading(previous => ({ ...previous, entries: false }));
          setErrors(previous => ({ ...previous, entries: undefined }));
          break;
        case 'customLogViewerEntryFields':
          setEntryFields(previous => ({ ...previous, [msg.entryId]: msg.fields || [] }));
          setErrors(previous => ({ ...previous, entry: undefined }));
          break;
        case 'customLogViewerPayloadColumns':
          setColumnsView(msg.value ?? EMPTY_COLUMNS);
          break;
        case 'customLogViewerLoading':
          setLoading(previous => ({ ...previous, [msg.scope]: !!msg.value }));
          break;
        case 'customLogViewerError':
          setErrors(previous => ({ ...previous, [msg.scope]: msg.message }));
          break;
      }
    };
    messageBus.addEventListener('message', onMessage as EventListener);
    vscode.postMessage({ type: 'customLogViewerReady' });
    return () => messageBus.removeEventListener('message', onMessage as EventListener);
  }, [messageBus, vscode]);

  const post = useCallback((message: CustomLogViewerFromWebviewMessage) => vscode.postMessage(message), [vscode]);

  const hasEntryPayload = useMemo(() => entries.some(entry => entry.payload !== undefined), [entries]);
  const onAddedColumns = useCallback(
    (added: string[]) => {
      setColumnsView(previous => ({ ...previous, added }));
      post({ type: 'customLogViewerSetPayloadColumns', added });
    },
    [post]
  );
  const buildColumns = useCallback(
    (payload: PayloadColumn[], discovered: DiscoveredField[]) =>
      buildEntryColumns({
        labels: t.viewer.columns,
        extra: entryColumns,
        payload,
        discovered,
        hasOrigin: entries.some(entry => entry.origin !== undefined)
      }),
    [entries, entryColumns, t.viewer.columns]
  );
  const workbench = usePayloadWorkbench({
    initial: initialUiState,
    payloadFields,
    itemCount: entries.length,
    columnsView,
    onAddedColumns,
    buildColumns
  });
  const { discovered, activeColumns, lockedColumns, columns, payloadFilters, filtering } = workbench;

  useEffect(() => {
    vscode.setState({ ...workbench.uiState, showSystem } satisfies CustomLogViewerUiState);
  }, [showSystem, vscode, workbench.uiState]);

  const visibleEntries = useMemo(
    () =>
      workbench.sortItems(
        filterEntries(entries, { levels, details, text: search, showSystem, payload: payloadFilters }),
        entrySortValue
      ),
    [details, entries, levels, payloadFilters, search, showSystem, workbench.sortItems]
  );

  const selectedEntry = useMemo(
    () => visibleEntries.find(entry => entry.id === selectedId),
    [selectedId, visibleEntries]
  );
  const levelCounts = useMemo(() => countLevels(entries), [entries]);
  const detailCounts = useMemo(() => countPresentDetails(entries), [entries]);
  const systemCount = useMemo(() => countSystemEntries(entries), [entries]);
  const payloadStates = useMemo(() => countPayloadStates(entries), [entries]);
  const dock = detailDock(rootHeight);

  const onSubmitFilter = useCallback(
    (text: string): FilterSubmitResult => {
      const parsed = parseFilterExpression(text);
      if (!parsed.ok) {
        return describeParseError(t.errors, parsed.error);
      }
      workbench.addPayloadFilters(
        parsed.conditions.map(condition => ({
          field: condition.field,
          op: condition.op,
          ...(condition.value === undefined ? {} : { value: condition.value })
        }))
      );
      return { ok: true };
    },
    [t.errors, workbench.addPayloadFilters]
  );

  const guidedFields = useMemo<GuidedField[]>(
    () => guidedPayloadFields(discovered, activeColumns),
    [activeColumns, discovered]
  );
  const valuesFor = useCallback(
    (field: string, prefix: string): GuidedItem[] => payloadValueSuggestions(visibleEntries, field, prefix),
    [visibleEntries]
  );

  const onSelectEntry = useCallback(
    (entry: CustomLogEntry) => {
      setSelectedId(entry.id);
      if (!entryFields[entry.id]) {
        post({ type: 'customLogViewerOpenEntry', entryId: entry.id });
      }
    },
    [entryFields, post]
  );

  const errorMessages = (Object.entries(errors) as Array<[ViewerError, string | undefined]>).filter(
    (entry): entry is [ViewerError, string] => Boolean(entry[1])
  );

  const emptyMessage = (() => {
    if (loading.entries && entries.length === 0) {
      return undefined;
    }
    if (entries.length === 0) {
      return t.viewer.noEntries;
    }
    if (visibleEntries.length === 0) {
      return [t.viewer.noMatch, hasMore ? t.viewer.noMatchMore : ''].filter(Boolean).join(' ');
    }
    return undefined;
  })();

  const narrowed = visibleEntries.length !== entries.length;

  return (
    <div
      ref={rootRef}
      data-testid="custom-log-viewer-root"
      className="relative flex h-screen min-h-[120px] flex-col overflow-hidden bg-background text-sm text-foreground"
    >
      <CustomLogViewerHeader
        t={t}
        source={source}
        log={log}
        logPayload={logPayload}
        apexLog={apexLog}
        loading={loading.log || loading.entries}
        onRefresh={() => post({ type: 'customLogViewerRefresh' })}
        onOpenApexLog={() => post({ type: 'customLogViewerOpenApexLog' })}
        onOpenLogPayload={() => post({ type: 'customLogViewerOpenField', target: { kind: 'logPayload' } })}
        onCopy={text => post({ type: 'customLogViewerCopyText', text })}
      />
      {errorMessages.map(([scope, message]) => (
        <div
          key={scope}
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-1 text-xs text-destructive"
        >
          <b>{t.viewer.errors[scope]}:</b> {message}
        </div>
      ))}
      <CustomLogViewerToolbar
        t={t}
        search={search}
        onSearchChange={setSearch}
        levels={levelCounts}
        selectedLevels={levels}
        onToggleLevel={level => setLevels(previous => toggled(previous, level))}
        details={detailCounts}
        selectedDetails={details}
        onToggleDetail={key => setDetails(previous => toggled(previous, key))}
        systemCount={systemCount}
        showSystem={showSystem}
        onShowSystemChange={setShowSystem}
      />
      {hasEntryPayload ? (
        <CustomLogsFilterBar
          t={t}
          chips={workbench.loadedChips}
          fields={guidedFields}
          valuesFor={valuesFor}
          onSubmit={onSubmitFilter}
          onAddColumn={path => !activeColumns.has(path) && workbench.toggleColumn(path)}
          prefill={workbench.prefill}
        />
      ) : null}
      <div className={dock === 'right' ? 'flex min-h-0 flex-1 flex-row' : 'flex min-h-0 flex-1 flex-col'}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {emptyMessage ? (
            <p className="m-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : null}
          <CustomLogEntryList
            t={t}
            entries={visibleEntries}
            columns={columns}
            sort={workbench.sort}
            selectedId={selectedId}
            discovered={discovered}
            activeColumns={activeColumns}
            lockedColumns={lockedColumns}
            onSort={workbench.onSort}
            onSelect={onSelectEntry}
            onToggleColumn={workbench.toggleColumn}
            onRemoveColumn={workbench.removeColumn}
            onFilterBy={path => workbench.requestFilterPrefill(`${path} `)}
            virtualListComponent={virtualListComponent}
          />
          <LoadingOverlay show={loading.entries && entries.length === 0} label={t.viewer.loading} />
        </div>
        {selectedEntry ? (
          <CustomLogEntryDetail
            t={t}
            entry={selectedEntry}
            dock={dock}
            fields={entryFields[selectedEntry.id]}
            loadingFields={loading.entry}
            columns={activeColumns}
            lockedColumns={lockedColumns}
            onClose={() => setSelectedId(undefined)}
            onCopyMessage={message => post({ type: 'customLogViewerCopyText', text: message })}
            onOpenField={key =>
              post({ type: 'customLogViewerOpenField', target: { kind: 'entry', entryId: selectedEntry.id, key } })
            }
            onToggleColumn={workbench.toggleColumn}
            onFilterEqual={workbench.filterEqual}
          />
        ) : null}
      </div>
      <CustomLogsStatusBar
        t={t}
        scope={
          narrowed
            ? fillTemplate(t.viewer.status.entriesShown, {
                shown: formatCount(visibleEntries.length, locale),
                loaded: formatCount(entries.length, locale)
              })
            : entries.length === 1
              ? t.viewer.status.entriesLoadedOne
              : fillTemplate(t.viewer.status.entriesLoaded, { count: formatCount(entries.length, locale) })
        }
        filtering={filtering}
        payloadInUse={workbench.payloadInUse}
        payloadStates={payloadStates}
        hasMore={hasMore}
        loading={loading.entries}
        onLoadMore={() => post({ type: 'customLogViewerLoadMoreEntries' })}
      />
    </div>
  );
}

export function mountCustomLogViewerApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<CustomLogViewerFromWebviewMessage>; messageBus?: MessageBus } = {}
) {
  const root = createRoot(container);
  root.render(
    <CustomLogViewerApp
      vscode={options.vscode ?? getDefaultVsCodeApi<CustomLogViewerFromWebviewMessage>()}
      messageBus={options.messageBus ?? getDefaultMessageBus()}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('root');
  if (host) {
    mountCustomLogViewerApp(host);
  }
}
