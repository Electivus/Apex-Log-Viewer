import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_LOG_LEVELS,
  DEFAULT_DEBUG_LEVEL_PRESET_ID,
  createEmptyDebugLevelRecord
} from '@alv/protocol/debugLevelPresets';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '@alv/protocol/debugFlagsMessages';
import {
  DEFAULT_TRACE_FLAG_LOG_TYPE,
  TRACE_FLAG_LOG_TYPES,
  getTraceFlagTargetKey,
  type DebugFlagUser,
  type DebugLevelPreset,
  type DebugLevelRecord,
  type TraceFlagLogType,
  type TraceFlagOtherLogTypeStatus,
  type TraceFlagTarget,
  type TraceFlagTargetStatus
} from '@alv/protocol/debugFlagsTypes';
import type { OrgItem } from '@alv/protocol/types';
import type { MessageBus, VsCodeWebviewApi } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';
import { getMessages, type Messages } from './i18n';
import { OrgSelect } from './components/OrgSelect';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Button } from './components/ui/button';
import { LabeledSelect } from './components/LabeledSelect';
import { cn } from './lib/utils';
import { getApplyBlocker, isAuthenticatedUser, orderUsersForPicker } from './utils/debugFlags';
import * as Popover from '@radix-ui/react-popover';
import { AlertCircle, CheckCircle2, Info, Loader2, Trash2, UserRound } from 'lucide-react';

export interface DebugFlagsAppProps {
  vscode?: VsCodeWebviewApi<DebugFlagsFromWebviewMessage>;
  messageBus?: MessageBus;
}

type LoadingState = {
  orgs: boolean;
  users: boolean;
  status: boolean;
  action: boolean;
};

type NoticeState = {
  tone: 'success' | 'info' | 'warning';
  message: string;
};

function cloneDebugLevelRecord(record?: DebugLevelRecord): DebugLevelRecord {
  const base = createEmptyDebugLevelRecord();
  if (!record) {
    return base;
  }
  return {
    ...base,
    ...record,
    id: record.id
  };
}

function debugLevelDraftEquals(left: DebugLevelRecord, right: DebugLevelRecord): boolean {
  const { id: _leftId, ...leftComparable } = left;
  const { id: _rightId, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale || 'en', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

type OtherLogTypeNote = { kind: 'overridden' | 'hidden'; other: TraceFlagOtherLogTypeStatus };

/** Fills `{expiration}` with the date kept on one line, so a narrow panel does not split the date or the time. */
function withNoWrapExpiration(template: string, expiration: string): React.ReactNode[] {
  return template.split('{expiration}').flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={index} className="whitespace-nowrap" data-testid="debug-flags-other-log-type-expiration">
            {expiration}
          </span>,
          part
        ]
  );
}

/** An active flag of the other type either overrides this USER_DEBUG level or is the only flag a DEVELOPER_LOG read misses. */
function getOtherLogTypeNote(status: TraceFlagTargetStatus | undefined): OtherLogTypeNote | undefined {
  const other = status?.targetAvailable ? status.otherLogType : undefined;
  if (!status || !other?.isActive) {
    return undefined;
  }
  if (status.logType === 'USER_DEBUG' && other.logType === 'DEVELOPER_LOG') {
    return { kind: 'overridden', other };
  }
  if (status.logType === 'DEVELOPER_LOG' && !status.isActive && other.logType === 'USER_DEBUG') {
    return { kind: 'hidden', other };
  }
  return undefined;
}

type Tone = NoticeState['tone'];

const INLINE_SELECT = 'min-w-0 flex-row items-center gap-2 [&>label]:whitespace-nowrap';
const FIELD_LABEL = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';
const STATUS_LIST = 'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5';

const ROW_BUTTON =
  'rounded-sm transition-colors hover:bg-[var(--vscode-list-hoverBackground,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const ROW_SELECTED =
  'bg-[var(--vscode-list-activeSelectionBackground,transparent)] hover:bg-[var(--vscode-list-activeSelectionBackground,transparent)] text-[var(--vscode-list-activeSelectionForeground,inherit)] outline outline-1 -outline-offset-1 outline-[color:var(--vscode-contrastActiveBorder,transparent)]';

const TONE_STRIP: Record<Tone, string> = {
  success: 'border-[var(--vscode-charts-green)] bg-[color-mix(in_srgb,var(--vscode-charts-green)_12%,transparent)]',
  warning:
    'border-[var(--vscode-editorWarning-foreground)] bg-[color-mix(in_srgb,var(--vscode-editorWarning-foreground)_12%,transparent)]',
  info: 'border-[var(--vscode-editorInfo-foreground)] bg-[color-mix(in_srgb,var(--vscode-editorInfo-foreground)_12%,transparent)]'
};
const TONE_ICON: Record<Tone, string> = {
  success: 'text-[var(--vscode-charts-green)]',
  warning: 'text-[var(--vscode-editorWarning-foreground)]',
  info: 'text-[var(--vscode-editorInfo-foreground)]'
};
const TONE_PILL_ACTIVE = 'bg-[color-mix(in_srgb,var(--vscode-charts-green)_22%,transparent)] text-foreground';

const SPECIAL_TARGETS = [
  {
    type: 'automatedProcess',
    testId: 'debug-flags-special-target-automated-process',
    label: (t: Messages) => t.debugFlags?.specialTargetAutomatedProcess ?? 'Automated Process',
    hint: (t: Messages) =>
      t.debugFlags?.specialTargetAutomatedProcessHint ?? 'Capture callbacks and system automation logs.'
  },
  {
    type: 'platformIntegration',
    testId: 'debug-flags-special-target-platform-integration',
    label: (t: Messages) => t.debugFlags?.specialTargetPlatformIntegration ?? 'Platform Integration',
    hint: (t: Messages) =>
      t.debugFlags?.specialTargetPlatformIntegrationHint ?? 'Capture asynchronous integration callback logs.'
  }
] as const;

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function DebugFlagsApp({
  vscode = getDefaultVsCodeApi<DebugFlagsFromWebviewMessage>(),
  messageBus = getDefaultMessageBus()
}: DebugFlagsAppProps = {}) {
  const [locale, setLocale] = useState('en');
  const [t, setT] = useState<Messages>(() => getMessages('en'));
  const [orgs, setOrgs] = useState<OrgItem[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<DebugFlagUser[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<TraceFlagTarget | undefined>(undefined);
  const [logType, setLogType] = useState<TraceFlagLogType>(DEFAULT_TRACE_FLAG_LOG_TYPE);
  const [status, setStatus] = useState<TraceFlagTargetStatus | undefined>(undefined);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [debugLevel, setDebugLevel] = useState('');
  const [managerRecords, setManagerRecords] = useState<DebugLevelRecord[]>([]);
  const [managerPresets, setManagerPresets] = useState<DebugLevelPreset[]>([]);
  const [selectedManagerId, setSelectedManagerId] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_DEBUG_LEVEL_PRESET_ID);
  const [loadedManagerDraft, setLoadedManagerDraft] = useState<DebugLevelRecord>(() => createEmptyDebugLevelRecord());
  const [managerDraft, setManagerDraft] = useState<DebugLevelRecord>(() => createEmptyDebugLevelRecord());
  const [confirmDeleteManager, setConfirmDeleteManager] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState('30');
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<NoticeState | undefined>(undefined);
  const [initialized, setInitialized] = useState(false);
  const selectedOrgRef = useRef<string | undefined>(undefined);
  const selectedTargetRef = useRef<TraceFlagTarget | undefined>(undefined);
  const logTypeRef = useRef<TraceFlagLogType>(DEFAULT_TRACE_FLAG_LOG_TYPE);
  const selectedManagerIdRef = useRef<string>('');
  const queryRef = useRef('');
  const [loading, setLoading] = useState<LoadingState>({
    orgs: false,
    users: false,
    status: false,
    action: false
  });

  useEffect(() => {
    selectedOrgRef.current = selectedOrg;
  }, [selectedOrg]);

  useEffect(() => {
    selectedTargetRef.current = selectedTarget;
  }, [selectedTarget]);

  useEffect(() => {
    logTypeRef.current = logType;
  }, [logType]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    selectedManagerIdRef.current = selectedManagerId;
  }, [selectedManagerId]);

  useEffect(() => {
    if (!messageBus) {
      vscode.postMessage({ type: 'debugFlagsReady' });
      return;
    }
    const handler = (event: MessageEvent) => {
      const msg = event.data as DebugFlagsToWebviewMessage;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      switch (msg.type) {
        case 'debugFlagsInit':
          setLocale(msg.locale);
          setT(getMessages(msg.locale));
          setTtlMinutes(String(msg.defaultTtlMinutes || 30));
          setInitialized(true);
          break;
        case 'debugFlagsLoading':
          setLoading(prev => ({
            ...prev,
            [msg.scope]: msg.value
          }));
          break;
        case 'debugFlagsOrgs':
          if (selectedOrgRef.current !== msg.selected) {
            setUsers([]);
            setSelectedTarget(undefined);
            setStatus(undefined);
            setNotice(undefined);
            setError(undefined);
          }
          setOrgs(msg.data || []);
          setSelectedOrg(msg.selected);
          break;
        case 'debugFlagsUsers': {
          if (String(msg.query || '') !== queryRef.current) {
            return;
          }
          const nextUsers = msg.data || [];
          setUsers(nextUsers);
          // The host drops a selected user that the new search no longer lists, so drop it here too.
          const current = selectedTargetRef.current;
          if (current?.type === 'user' && !nextUsers.some(user => user.id === current.userId)) {
            setSelectedTarget(undefined);
            setStatus(undefined);
          }
          break;
        }
        case 'debugFlagsDebugLevels': {
          const values = msg.data || [];
          setDebugLevels(values);
          if (typeof msg.active === 'string' && msg.active) {
            setDebugLevel(msg.active);
          } else if (values.length > 0) {
            setDebugLevel(prev => prev || values[0]!);
          }
          break;
        }
        case 'debugFlagsManagerData': {
          const records = msg.records || [];
          const presets = msg.presets || [];
          const preferredId = msg.selectedId || selectedManagerIdRef.current;
          const selectedRecord = records.find(record => record.id === preferredId) || records[0];
          const nextDraft = cloneDebugLevelRecord(selectedRecord);
          setManagerRecords(records);
          setManagerPresets(presets);
          setSelectedManagerId(selectedRecord?.id || '');
          setSelectedPresetId(DEFAULT_DEBUG_LEVEL_PRESET_ID);
          setLoadedManagerDraft(nextDraft);
          setManagerDraft(nextDraft);
          setConfirmDeleteManager(false);
          break;
        }
        case 'debugFlagsTargetStatus':
          // A status read for the previous log type can land after the user switched types.
          if (
            getTraceFlagTargetKey(msg.target) === getTraceFlagTargetKey(selectedTargetRef.current) &&
            (!msg.status || msg.status.logType === logTypeRef.current)
          ) {
            setStatus(msg.status);
          }
          break;
        case 'debugFlagsNotice':
          setError(undefined);
          setNotice({
            tone: msg.tone,
            message: msg.message
          });
          break;
        case 'debugFlagsError':
          setNotice(undefined);
          setError(msg.message);
          break;
      }
    };
    messageBus.addEventListener('message', handler as EventListener);
    vscode.postMessage({ type: 'debugFlagsReady' });
    return () => messageBus.removeEventListener('message', handler as EventListener);
  }, [messageBus, vscode]);

  useEffect(() => {
    if (!initialized || !selectedOrg) {
      return;
    }
    const handle = setTimeout(() => {
      vscode.postMessage({ type: 'debugFlagsSearchUsers', query });
    }, 300);
    return () => clearTimeout(handle);
  }, [initialized, selectedOrg, query, vscode]);

  const selectedUserId = selectedTarget?.type === 'user' ? selectedTarget.userId : undefined;
  const selectedUser = useMemo(() => users.find(user => user.id === selectedUserId), [users, selectedUserId]);
  const selectedTargetLabel = useMemo(() => {
    if (!selectedTarget) {
      return '';
    }
    if (selectedTarget.type === 'user') {
      return selectedUser?.name || selectedUser?.username || 'User';
    }
    return selectedTarget.type === 'automatedProcess'
      ? (t.debugFlags?.specialTargetAutomatedProcess ?? 'Automated Process')
      : (t.debugFlags?.specialTargetPlatformIntegration ?? 'Platform Integration');
  }, [selectedTarget, selectedUser, t]);
  const specialTargetSelected = Boolean(selectedTarget && selectedTarget.type !== 'user');
  const specialTargetReady = !specialTargetSelected || status?.targetAvailable === true;
  const specialTargetResolvedCount = specialTargetSelected ? (status?.resolvedTargetCount ?? 0) : 0;
  const specialTargetActiveCount = specialTargetSelected ? (status?.activeTargetCount ?? 0) : 0;
  const shouldRenderStatusDetails = Boolean(
    status?.traceFlagId || (specialTargetSelected && specialTargetActiveCount > 0)
  );
  const otherLogTypeNote = loading.status ? undefined : getOtherLogTypeNote(status);
  const otherLogTypeNoteTemplates: Record<OtherLogTypeNote['kind'], string> = {
    overridden:
      t.debugFlags?.otherLogTypeOverridden ??
      "A DEVELOPER_LOG trace flag is also active {where} until {expiration}. Salesforce writes each transaction's log at that flag's debug level, so this USER_DEBUG level does not apply until then.",
    hidden: t.debugFlags?.otherLogTypeHidden ?? 'A USER_DEBUG trace flag is active {where} until {expiration}.'
  };
  const otherLogTypeWhere = specialTargetSelected
    ? (t.debugFlags?.otherLogTypeOnMatchedTargets ?? 'on {active} of {resolved} matched targets')
        .replace('{active}', String(otherLogTypeNote?.other.activeTargetCount ?? 0))
        .replace('{resolved}', String(specialTargetResolvedCount))
    : (t.debugFlags?.otherLogTypeOnThisTarget ?? 'on this target');
  const otherLogTypeNoteText = otherLogTypeNote
    ? withNoWrapExpiration(
        otherLogTypeNoteTemplates[otherLogTypeNote.kind].replace('{where}', otherLogTypeWhere),
        formatDate(otherLogTypeNote.other.expirationDate, locale)
      )
    : undefined;
  const managerDraftDirty = !debugLevelDraftEquals(managerDraft, loadedManagerDraft);

  const canApply = Boolean(selectedTarget && debugLevel && !loading.action && !loading.orgs && specialTargetReady);
  const canRemove = Boolean(selectedTarget && !loading.action && !loading.orgs && specialTargetReady);
  const canSaveManager = Boolean(
    !loading.action &&
    !loading.orgs &&
    managerDraft.developerName.trim() &&
    managerDraft.masterLabel.trim() &&
    managerDraftDirty
  );
  const canDeleteManager = Boolean(selectedManagerId && !loading.action && !loading.orgs);
  const logTypeLabels: Record<TraceFlagLogType, string> = {
    DEVELOPER_LOG: t.debugFlags?.logTypeDeveloperLog ?? 'Developer log (DEVELOPER_LOG)',
    USER_DEBUG: t.debugFlags?.logTypeUserDebug ?? 'User debug (USER_DEBUG)'
  };

  const handleSelectOrg = (nextOrg: string) => {
    setSelectedOrg(nextOrg);
    setUsers([]);
    setSelectedTarget(undefined);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectOrg', target: nextOrg });
  };

  const handleSelectUser = (userId: string) => {
    setSelectedTarget({ type: 'user', userId });
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectTarget', target: { type: 'user', userId }, logType });
  };

  const handleSelectSpecialTarget = (
    target: Extract<TraceFlagTarget, { type: 'automatedProcess' | 'platformIntegration' }>
  ) => {
    setSelectedTarget(target);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectTarget', target, logType });
  };

  const handleSelectLogType = (value: string) => {
    const nextLogType = TRACE_FLAG_LOG_TYPES.find(candidate => candidate === value);
    if (!nextLogType || nextLogType === logType) {
      return;
    }
    setLogType(nextLogType);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    if (selectedTarget) {
      vscode.postMessage({ type: 'debugFlagsSelectTarget', target: selectedTarget, logType: nextLogType });
    }
  };

  const handleApply = () => {
    if (!selectedTarget || !debugLevel) {
      return;
    }
    const ttl = Number(ttlMinutes);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 1440) {
      setError(t.debugFlags?.ttlHelper ?? 'Default is 30 minutes. Allowed range: 1-1440.');
      return;
    }
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({
      type: 'debugFlagsApply',
      target: selectedTarget,
      logType,
      debugLevelName: debugLevel,
      ttlMinutes: Math.floor(ttl)
    });
  };

  const handleRemove = () => {
    if (!selectedTarget) {
      return;
    }
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({
      type: 'debugFlagsRemove',
      target: selectedTarget,
      logType
    });
  };

  const handleClearLogs = (scope: 'all' | 'mine') => {
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({
      type: 'debugFlagsClearLogs',
      scope
    });
  };

  const handleSelectManager = (nextId: string) => {
    setSelectedManagerId(nextId);
    setSelectedPresetId(DEFAULT_DEBUG_LEVEL_PRESET_ID);
    const selectedRecord = managerRecords.find(record => record.id === nextId);
    const nextDraft = cloneDebugLevelRecord(selectedRecord);
    setLoadedManagerDraft(nextDraft);
    setManagerDraft(nextDraft);
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const handleNewManager = () => {
    const nextDraft = createEmptyDebugLevelRecord();
    setSelectedManagerId('');
    setSelectedPresetId(DEFAULT_DEBUG_LEVEL_PRESET_ID);
    setLoadedManagerDraft(nextDraft);
    setManagerDraft(nextDraft);
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const selectedPreset = managerPresets.find(item => item.id === selectedPresetId);

  const handleApplyPreset = () => {
    if (!selectedPreset) {
      return;
    }
    setManagerDraft(prev => ({
      ...cloneDebugLevelRecord(selectedPreset.record),
      id: prev.id
    }));
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const handleManagerFieldChange = <K extends keyof DebugLevelRecord>(field: K, value: DebugLevelRecord[K]) => {
    setConfirmDeleteManager(false);
    setManagerDraft(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleResetManager = () => {
    setSelectedPresetId(DEFAULT_DEBUG_LEVEL_PRESET_ID);
    setManagerDraft(cloneDebugLevelRecord(loadedManagerDraft));
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const handleSaveManager = () => {
    if (!managerDraft.developerName.trim() || !managerDraft.masterLabel.trim()) {
      setNotice(undefined);
      setError(t.debugFlags?.managerValidation ?? 'DeveloperName and MasterLabel are required to save a DebugLevel.');
      return;
    }
    setNotice(undefined);
    setError(undefined);
    setConfirmDeleteManager(false);
    vscode.postMessage({
      type: 'debugFlagsManagerSave',
      draft: managerDraft
    });
  };

  const handleDeleteManager = () => {
    if (!selectedManagerId) {
      return;
    }
    if (!confirmDeleteManager) {
      setConfirmDeleteManager(true);
      setNotice(undefined);
      setError(undefined);
      return;
    }
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({
      type: 'debugFlagsManagerDelete',
      debugLevelId: selectedManagerId
    });
  };

  const handleCancelDeleteManager = () => {
    setConfirmDeleteManager(false);
  };

  const NoticeIcon = notice?.tone === 'success' ? CheckCircle2 : notice?.tone === 'warning' ? AlertCircle : Info;
  const authenticatedUsername = selectedOrg;
  const orderedUsers = useMemo(() => orderUsersForPicker(users, authenticatedUsername), [users, authenticatedUsername]);
  const applyBlocker = getApplyBlocker({ hasTarget: Boolean(selectedTarget), hasDebugLevel: Boolean(debugLevel) });
  const applyHint = applyBlocker
    ? applyBlocker === 'noTarget'
      ? (t.debugFlags?.applyHintNoTarget ?? 'Select a user or a special target to apply a debug flag.')
      : (t.debugFlags?.applyHintNoDebugLevel ?? 'Select a debug level to apply a debug flag.')
    : undefined;
  const busy = loading.orgs || loading.action;
  const targetLabelRow = (
    <StatusRow label={t.debugFlags?.selectedTarget ?? 'Selected target'}>
      <span className="text-foreground" data-testid="debug-flags-selected-target-label">
        {selectedTargetLabel}
      </span>
    </StatusRow>
  );
  const specialTargetRows = specialTargetSelected ? (
    <>
      <StatusRow label={t.debugFlags?.statusMatchedTargets ?? 'Matched targets'}>
        <span data-testid="debug-flags-status-resolved-count">{specialTargetResolvedCount}</span>
      </StatusRow>
      <StatusRow label={t.debugFlags?.statusActiveTargets ?? 'Active flags'}>
        <span data-testid="debug-flags-status-active-count">
          {specialTargetActiveCount}/{specialTargetResolvedCount}
        </span>
      </StatusRow>
    </>
  ) : null;

  return (
    <div className="relative flex h-screen min-h-[120px] flex-col overflow-hidden bg-background text-sm text-foreground">
      <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <OrgSelect
          label={t.debugFlags?.org ?? t.orgLabel}
          orgs={orgs}
          selected={selectedOrg}
          onChange={handleSelectOrg}
          testId="debug-flags-org-select"
          disabled={busy}
          emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
          className={INLINE_SELECT}
        />
      </section>

      {error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive"
          data-testid="debug-flags-error"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {!error && notice ? (
        <div
          role="status"
          className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs', TONE_STRIP[notice.tone])}
          data-testid="debug-flags-notice"
        >
          <NoticeIcon className={cn('h-4 w-4 shrink-0', TONE_ICON[notice.tone])} aria-hidden="true" />
          <span>{notice.message}</span>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 min-[900px]:grid-cols-[minmax(240px,1fr)_minmax(0,1.5fr)]">
          <section
            className="flex min-w-0 flex-col gap-3 p-3 min-[900px]:border-r min-[900px]:border-border"
            aria-label={t.debugFlags?.users ?? 'Active users'}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-flags-user-search" className={FIELD_LABEL}>
                {t.debugFlags?.userSearchLabel ?? 'Find user'}
              </Label>
              <Input
                id="debug-flags-user-search"
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t.debugFlags?.userSearchPlaceholder ?? 'Type name or username…'}
                disabled={busy}
                data-testid="debug-flags-user-search"
              />
            </div>

            <div className="flex flex-col gap-1">
              <h2 className={FIELD_LABEL}>{t.debugFlags?.users ?? 'Active users'}</h2>
              {loading.users ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{t.debugFlags?.loadingUsers ?? 'Loading users…'}</span>
                </div>
              ) : orderedUsers.length === 0 ? (
                <p className="text-muted-foreground">
                  {t.debugFlags?.noUsers ?? 'No active users found for this query.'}
                </p>
              ) : (
                <ul className="flex flex-col" data-testid="debug-flags-users-list">
                  {orderedUsers.map(user => {
                    const selected = user.id === selectedUserId;
                    return (
                      <li key={user.id}>
                        <button
                          type="button"
                          className={cn(
                            ROW_BUTTON,
                            'flex w-full items-center gap-2 px-2 py-1 text-left',
                            selected && ROW_SELECTED
                          )}
                          aria-pressed={selected}
                          onClick={() => handleSelectUser(user.id)}
                          data-testid={`debug-flags-user-row-${user.id}`}
                        >
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="truncate font-medium">{user.name}</span>
                            <span className="truncate text-xs text-muted-foreground">{user.username}</span>
                          </span>
                          {isAuthenticatedUser(user, authenticatedUsername) ? (
                            <span
                              className="shrink-0 rounded-full bg-secondary px-2 text-[11px] font-semibold text-secondary-foreground"
                              data-testid="debug-flags-you-badge"
                            >
                              {t.debugFlags?.youBadge ?? 'You'}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <h2 className={FIELD_LABEL}>{t.debugFlags?.specialTargets ?? 'Special targets'}</h2>
              <div className="flex flex-wrap gap-1">
                {SPECIAL_TARGETS.map(option => {
                  const selected = selectedTarget?.type === option.type;
                  return (
                    <button
                      key={option.type}
                      type="button"
                      className={cn(ROW_BUTTON, 'border border-border px-2 py-1 text-left', selected && ROW_SELECTED)}
                      aria-pressed={selected}
                      title={option.hint(t)}
                      onClick={() => handleSelectSpecialTarget({ type: option.type })}
                      disabled={busy}
                      data-testid={option.testId}
                    >
                      {option.label(t)}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="flex min-w-0 flex-col gap-3 px-3 pt-3">
            <div className="flex flex-col gap-1">
              <h2 className={FIELD_LABEL}>{t.debugFlags?.currentStatus ?? 'Current status'}</h2>

              {!selectedTarget ? (
                <p className="text-muted-foreground">
                  {t.debugFlags?.selectTargetHint ??
                    'Select a special target or an active user to inspect and configure debug flags.'}
                </p>
              ) : loading.status ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{t.loading}</span>
                </div>
              ) : status?.targetAvailable === false ? (
                <>
                  <dl className={STATUS_LIST}>{targetLabelRow}</dl>
                  <p className="flex items-start gap-1.5" data-testid="debug-flags-target-unavailable">
                    <AlertCircle className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON.warning)} aria-hidden="true" />
                    <span>
                      {status.unavailableReason ??
                        t.debugFlags?.targetUnavailable ??
                        'This trace flag target is not available in this org.'}
                    </span>
                  </p>
                </>
              ) : shouldRenderStatusDetails && status ? (
                <dl className={STATUS_LIST}>
                  {targetLabelRow}
                  {specialTargetRows}
                  <StatusRow label={t.debugFlags?.statusLabel ?? 'Status'}>
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 text-xs font-semibold',
                        status.isActive ? TONE_PILL_ACTIVE : 'bg-muted text-muted-foreground'
                      )}
                      data-testid="debug-flags-status-pill"
                    >
                      {status.isActive
                        ? (t.debugFlags?.statusActive ?? 'Active')
                        : (t.debugFlags?.statusInactive ?? 'Inactive')}
                    </span>
                  </StatusRow>
                  <StatusRow label={t.debugFlags?.statusLevel ?? 'Debug level'}>
                    <span data-testid="debug-flags-status-level">
                      {status.debugLevelMixed ? (t.debugFlags?.statusMixed ?? 'Mixed') : status.debugLevelName || '-'}
                    </span>
                  </StatusRow>
                  <StatusRow label={t.debugFlags?.statusStart ?? 'Starts'}>
                    {formatDate(status.startDate, locale)}
                  </StatusRow>
                  <StatusRow label={t.debugFlags?.statusExpiration ?? 'Expires'}>
                    <span data-testid="debug-flags-status-expiration">{formatDate(status.expirationDate, locale)}</span>
                  </StatusRow>
                </dl>
              ) : (
                <>
                  <dl className={STATUS_LIST}>
                    {targetLabelRow}
                    {specialTargetRows}
                  </dl>
                  <p className="text-muted-foreground">
                    {(t.debugFlags?.noStatus ?? 'No active {logType} trace flag for this target.').replace(
                      '{logType}',
                      logType
                    )}
                  </p>
                </>
              )}

              {otherLogTypeNote ? (
                <div
                  className={cn(
                    'mt-1 flex items-start gap-2 rounded-md border px-2 py-1 text-xs',
                    TONE_STRIP[otherLogTypeNote.kind === 'overridden' ? 'warning' : 'info']
                  )}
                  data-testid="debug-flags-other-log-type-note"
                >
                  {otherLogTypeNote.kind === 'overridden' ? (
                    <AlertCircle className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON.warning)} aria-hidden="true" />
                  ) : (
                    <Info className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON.info)} aria-hidden="true" />
                  )}
                  <div className="space-y-1">
                    <p>{otherLogTypeNoteText}</p>
                    {otherLogTypeNote.kind === 'hidden' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleSelectLogType(otherLogTypeNote.other.logType)}
                        disabled={busy}
                        data-testid="debug-flags-other-log-type-switch"
                      >
                        {t.debugFlags?.otherLogTypeSwitch ?? 'Show USER_DEBUG flag'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <LabeledSelect
                label={t.debugFlags?.logType ?? 'Log type'}
                value={logType}
                onChange={handleSelectLogType}
                options={TRACE_FLAG_LOG_TYPES.map(value => ({ value, label: logTypeLabels[value] }))}
                testId="debug-flags-log-type"
                disabled={busy}
                className="min-w-0"
              />
              <details className="text-xs text-muted-foreground" data-testid="debug-flags-log-type-help">
                <summary className="w-fit cursor-pointer select-none rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t.debugFlags?.aboutLogTypes ?? 'About log types'}
                </summary>
                <p className="mt-1">
                  {t.debugFlags?.logTypeHelper ??
                    "Developer logs also capture Apex checkpoints (heap dumps) and are kept for 24 hours. User debug logs are kept for 7 days. When a user has both types active, the developer log's debug level applies. The Developer Console uses the same DEVELOPER_LOG flag, so removing DEVELOPER_LOG here also removes the Console's flag, and the Console creates it again when it opens."}
                </p>
              </details>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
              <LabeledSelect
                label={t.debugFlags?.debugLevel ?? 'Debug level'}
                value={debugLevel}
                onChange={setDebugLevel}
                options={debugLevels.map(level => ({ value: level, label: level }))}
                placeholderLabel={t.tail?.select ?? 'Select'}
                testId="debug-flags-debug-level"
                disabled={busy}
                className="min-w-0"
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="debug-flags-ttl" className={FIELD_LABEL}>
                  {t.debugFlags?.ttlMinutes ?? 'TTL (minutes)'}
                </Label>
                <Input
                  id="debug-flags-ttl"
                  type="number"
                  value={ttlMinutes}
                  onChange={event => setTtlMinutes(event.target.value)}
                  min={1}
                  max={1440}
                  title={t.debugFlags?.ttlHelper ?? 'Default is 30 minutes. Allowed range: 1-1440.'}
                  disabled={busy}
                  data-testid="debug-flags-ttl"
                />
              </div>
            </div>

            <div className="sticky bottom-0 -mx-3 mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-2">
              <Button
                type="button"
                onClick={handleApply}
                disabled={!canApply}
                variant="default"
                aria-describedby={applyHint ? 'debug-flags-apply-hint' : undefined}
                data-testid="debug-flags-apply"
              >
                {loading.action ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span>{t.loading}</span>
                  </>
                ) : (
                  <span>{t.debugFlags?.apply ?? 'Apply debug flag'}</span>
                )}
              </Button>
              <Button
                type="button"
                onClick={handleRemove}
                disabled={!canRemove}
                variant="outline"
                data-testid="debug-flags-remove"
              >
                {t.debugFlags?.remove ?? 'Remove debug flag'}
              </Button>

              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    title={t.logsCleanup?.openTitle ?? 'Delete Apex logs from the selected org'}
                    className="flex items-center gap-2"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span>{t.logsCleanup?.open ?? 'Clear logs'}</span>
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    align="start"
                    sideOffset={8}
                    className={cn(
                      'z-50 w-[260px] rounded-lg border border-border bg-card p-2 shadow-lg outline-none',
                      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
                    )}
                  >
                    <div className="flex flex-col gap-1">
                      <Popover.Close asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="w-full justify-start"
                          onClick={() => handleClearLogs('mine')}
                          disabled={busy}
                        >
                          {t.logsCleanup?.deleteMine ?? 'Delete my logs'}
                        </Button>
                      </Popover.Close>
                      <Popover.Close asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="w-full justify-start text-destructive hover:text-destructive"
                          onClick={() => handleClearLogs('all')}
                          disabled={busy}
                        >
                          {t.logsCleanup?.deleteAll ?? 'Delete all org logs'}
                        </Button>
                      </Popover.Close>
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>

              {applyHint ? (
                <span
                  id="debug-flags-apply-hint"
                  className="text-xs text-muted-foreground"
                  data-testid="debug-flags-apply-hint"
                >
                  {applyHint}
                </span>
              ) : null}
            </div>
          </section>
        </div>

        <section className="border-t border-border p-3" data-testid="debug-level-manager">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-foreground">
              {t.debugFlags?.managerTitle ?? 'Debug Level Manager'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t.debugFlags?.managerSubtitle ??
                'Create from scratch, apply a preset, or edit an existing DebugLevel field by field.'}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_1fr_auto]">
            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-level-manager-select">
                {t.debugFlags?.managerExisting ?? 'Existing DebugLevel'}
              </Label>
              <select
                id="debug-level-manager-select"
                data-testid="debug-level-manager-select"
                value={selectedManagerId}
                onChange={event => handleSelectManager(event.target.value)}
                disabled={loading.orgs || loading.action || managerRecords.length === 0}
                className="flex min-h-[28px] w-full rounded-md border border-input bg-input px-3 py-1 text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">{t.debugFlags?.managerNewPlaceholder ?? 'New draft'}</option>
                {managerRecords.map(record => (
                  <option key={record.id || record.developerName} value={record.id}>
                    {record.developerName}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleNewManager}
                disabled={loading.orgs || loading.action}
                data-testid="debug-level-manager-new"
              >
                {t.debugFlags?.managerNew ?? 'New'}
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-level-preset-select">{t.debugFlags?.managerPreset ?? 'Preset'}</Label>
              <select
                id="debug-level-preset-select"
                data-testid="debug-level-preset-select"
                value={selectedPresetId}
                onChange={event => setSelectedPresetId(event.target.value)}
                disabled={loading.orgs || loading.action || managerPresets.length === 0}
                className="flex min-h-[28px] w-full rounded-md border border-input bg-input px-3 py-1 text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">{t.debugFlags?.managerPresetPlaceholder ?? 'Select a preset'}</option>
                {managerPresets.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleApplyPreset}
                disabled={!selectedPresetId || loading.orgs || loading.action}
                data-testid="debug-level-apply-preset"
              >
                {t.debugFlags?.managerApplyPreset ?? 'Apply preset'}
              </Button>
            </div>
            {selectedPreset ? (
              <p
                className="-mt-2 text-xs text-muted-foreground lg:col-span-2 lg:col-start-3"
                data-testid="debug-level-preset-description"
              >
                {selectedPreset.description}
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-level-draft-developer-name">
                {t.debugFlags?.managerDeveloperName ?? 'DeveloperName'}
              </Label>
              <Input
                id="debug-level-draft-developer-name"
                data-testid="debug-level-draft-developer-name"
                value={managerDraft.developerName}
                onChange={event => handleManagerFieldChange('developerName', event.target.value)}
                disabled={loading.orgs || loading.action}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-level-draft-master-label">
                {t.debugFlags?.managerMasterLabel ?? 'MasterLabel'}
              </Label>
              <Input
                id="debug-level-draft-master-label"
                data-testid="debug-level-draft-master-label"
                value={managerDraft.masterLabel}
                onChange={event => handleManagerFieldChange('masterLabel', event.target.value)}
                disabled={loading.orgs || loading.action}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-level-draft-language">{t.debugFlags?.managerLanguage ?? 'Language'}</Label>
              <Input
                id="debug-level-draft-language"
                data-testid="debug-level-draft-language"
                value={managerDraft.language}
                onChange={event => handleManagerFieldChange('language', event.target.value)}
                disabled={loading.orgs || loading.action}
              />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {DEBUG_LEVEL_FIELDS.map(field => (
              <div key={field.key} className="flex flex-col gap-1">
                <Label htmlFor={`debug-level-field-${field.key}`}>{field.label}</Label>
                <select
                  id={`debug-level-field-${field.key}`}
                  data-testid={`debug-level-field-${field.key}`}
                  value={managerDraft[field.key]}
                  onChange={event => handleManagerFieldChange(field.key, event.target.value)}
                  disabled={loading.orgs || loading.action}
                  className="flex min-h-[28px] w-full rounded-md border border-input bg-input px-3 py-1 text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {DEBUG_LEVEL_LOG_LEVELS.map(level => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleSaveManager}
              disabled={!canSaveManager}
              variant="secondary"
              data-testid="debug-level-save"
            >
              {t.debugFlags?.managerSave ?? 'Save'}
            </Button>
            <Button
              type="button"
              onClick={handleResetManager}
              disabled={!managerDraftDirty || loading.orgs || loading.action}
              variant="outline"
              data-testid="debug-level-reset"
            >
              {t.debugFlags?.managerReset ?? 'Reset changes'}
            </Button>
            <Button
              type="button"
              onClick={handleDeleteManager}
              disabled={!canDeleteManager}
              variant="outline"
              data-testid="debug-level-delete"
            >
              {t.debugFlags?.managerDelete ?? 'Delete'}
            </Button>
          </div>

          {confirmDeleteManager && (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="debug-level-delete-confirmation"
            >
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <span>{t.debugFlags?.managerDeleteConfirmPrompt ?? 'Delete this DebugLevel from the org?'}</span>
              <Button
                type="button"
                onClick={handleDeleteManager}
                disabled={!canDeleteManager}
                variant="destructive"
                data-testid="debug-level-delete-confirm"
              >
                {t.debugFlags?.managerDeleteConfirmAction ?? 'Delete'}
              </Button>
              <Button
                type="button"
                onClick={handleCancelDeleteManager}
                disabled={loading.action || loading.orgs}
                variant="outline"
                data-testid="debug-level-delete-cancel"
              >
                {t.debugFlags?.managerDeleteCancel ?? 'Cancel'}
              </Button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export function mountDebugFlagsApp(
  container: HTMLElement,
  options: { vscode?: VsCodeWebviewApi<DebugFlagsFromWebviewMessage>; messageBus?: MessageBus } = {}
) {
  const root = createRoot(container);
  root.render(
    <DebugFlagsApp
      vscode={options.vscode ?? getDefaultVsCodeApi<DebugFlagsFromWebviewMessage>()}
      messageBus={options.messageBus ?? getDefaultMessageBus()}
    />
  );
  return root;
}

if (typeof document !== 'undefined') {
  const container = document.getElementById('root');
  if (container) {
    mountDebugFlagsApp(container);
  }
}
