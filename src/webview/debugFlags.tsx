import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEBUG_LEVEL_FIELDS, DEBUG_LEVEL_LOG_LEVELS, createEmptyDebugLevelRecord } from '../shared/debugLevelPresets';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '../shared/debugFlagsMessages';
import {
  getTraceFlagTargetKey,
  type DebugFlagUser,
  type DebugLevelPreset,
  type DebugLevelRecord,
  type TraceFlagTarget,
  type TraceFlagTargetStatus
} from '../shared/debugFlagsTypes';
import type { OrgItem } from '../shared/types';
import type { MessageBus, VsCodeWebviewApi } from './vscodeApi';
import { getDefaultMessageBus, getDefaultVsCodeApi } from './vscodeApi';
import { getMessages, type Messages } from './i18n';
import { OrgSelect } from './components/OrgSelect';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Button } from './components/ui/button';
import { LabeledSelect } from './components/LabeledSelect';
import { cn } from './lib/utils';
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
  const [status, setStatus] = useState<TraceFlagTargetStatus | undefined>(undefined);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [debugLevel, setDebugLevel] = useState('');
  const [managerRecords, setManagerRecords] = useState<DebugLevelRecord[]>([]);
  const [managerPresets, setManagerPresets] = useState<DebugLevelPreset[]>([]);
  const [selectedManagerId, setSelectedManagerId] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [loadedManagerDraft, setLoadedManagerDraft] = useState<DebugLevelRecord>(() => createEmptyDebugLevelRecord());
  const [managerDraft, setManagerDraft] = useState<DebugLevelRecord>(() => createEmptyDebugLevelRecord());
  const [confirmDeleteManager, setConfirmDeleteManager] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState('30');
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<NoticeState | undefined>(undefined);
  const [initialized, setInitialized] = useState(false);
  const selectedOrgRef = useRef<string | undefined>(undefined);
  const selectedTargetRef = useRef<TraceFlagTarget | undefined>(undefined);
  const selectedManagerIdRef = useRef<string>('');
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
        case 'debugFlagsUsers':
          setUsers(msg.data || []);
          break;
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
          setSelectedPresetId('');
          setLoadedManagerDraft(nextDraft);
          setManagerDraft(nextDraft);
          setConfirmDeleteManager(false);
          break;
        }
        case 'debugFlagsTargetStatus':
          if (getTraceFlagTargetKey(msg.target) === getTraceFlagTargetKey(selectedTargetRef.current)) {
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
  const selectedUser = useMemo(
    () => users.find(user => user.id === selectedUserId),
    [users, selectedUserId]
  );
  const selectedTargetLabel = useMemo(() => {
    if (!selectedTarget) {
      return '';
    }
    if (selectedTarget.type === 'user') {
      return selectedUser?.name || selectedUser?.username || 'User';
    }
    return selectedTarget.type === 'automatedProcess'
      ? t.debugFlags?.specialTargetAutomatedProcess ?? 'Automated Process'
      : t.debugFlags?.specialTargetPlatformIntegration ?? 'Platform Integration';
  }, [selectedTarget, selectedUser, t]);
  const specialTargetSelected = Boolean(selectedTarget && selectedTarget.type !== 'user');
  const specialTargetReady = !specialTargetSelected || status?.targetAvailable === true;
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
    vscode.postMessage({ type: 'debugFlagsSelectTarget', target: { type: 'user', userId } });
  };

  const handleSelectSpecialTarget = (target: Extract<TraceFlagTarget, { type: 'automatedProcess' | 'platformIntegration' }>) => {
    setSelectedTarget(target);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectTarget', target });
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
      target: selectedTarget
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
    setSelectedPresetId('');
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
    setSelectedPresetId('');
    setLoadedManagerDraft(nextDraft);
    setManagerDraft(nextDraft);
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const handleApplyPreset = () => {
    const preset = managerPresets.find(item => item.id === selectedPresetId);
    if (!preset) {
      return;
    }
    setManagerDraft(prev => ({
      ...cloneDebugLevelRecord(preset.record),
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
    setSelectedPresetId('');
    setManagerDraft(cloneDebugLevelRecord(loadedManagerDraft));
    setConfirmDeleteManager(false);
    setNotice(undefined);
    setError(undefined);
  };

  const handleSaveManager = () => {
    if (!managerDraft.developerName.trim() || !managerDraft.masterLabel.trim()) {
      setNotice(undefined);
      setError(
        t.debugFlags?.managerValidation ?? 'DeveloperName and MasterLabel are required to save a DebugLevel.'
      );
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

  const noticeIcon = notice?.tone === 'success' ? CheckCircle2 : notice?.tone === 'warning' ? AlertCircle : Info;
  const NoticeIcon = noticeIcon;

  return (
    <div className="flex min-h-screen flex-col gap-4 p-4 text-sm">
      <header className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          {t.debugFlags?.panelTitle ?? 'Apex Debug Flags'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.debugFlags?.panelSubtitle ?? 'Configure USER_DEBUG trace flags with room to focus.'}
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <OrgSelect
            label={t.debugFlags?.org ?? t.orgLabel}
            orgs={orgs}
            selected={selectedOrg}
            onChange={handleSelectOrg}
            disabled={loading.orgs || loading.action}
            emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
          />
        </div>
      </section>

      <section className="grid min-h-[420px] grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <article className="rounded-lg border border-border bg-card/70 p-3 shadow-sm">
          <div className="space-y-4">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t.debugFlags?.specialTargets ?? 'Special targets'}
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className={cn(
                    'rounded-md border px-3 py-3 text-left transition-colors',
                    selectedTarget?.type === 'automatedProcess'
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border bg-background/50 hover:bg-muted/60'
                  )}
                  onClick={() => handleSelectSpecialTarget({ type: 'automatedProcess' })}
                  disabled={loading.orgs || loading.action}
                  data-testid="debug-flags-special-target-automated-process"
                >
                  <span className="block font-medium">
                    {t.debugFlags?.specialTargetAutomatedProcess ?? 'Automated Process'}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t.debugFlags?.specialTargetAutomatedProcessHint ?? 'Capture callbacks and system automation logs.'}
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded-md border px-3 py-3 text-left transition-colors',
                    selectedTarget?.type === 'platformIntegration'
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border bg-background/50 hover:bg-muted/60'
                  )}
                  onClick={() => handleSelectSpecialTarget({ type: 'platformIntegration' })}
                  disabled={loading.orgs || loading.action}
                  data-testid="debug-flags-special-target-platform-integration"
                >
                  <span className="block font-medium">
                    {t.debugFlags?.specialTargetPlatformIntegration ?? 'Platform Integration'}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t.debugFlags?.specialTargetPlatformIntegrationHint ?? 'Capture asynchronous integration callback logs.'}
                  </span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-flags-user-search">
                {t.debugFlags?.userSearchLabel ?? 'Find user'}
              </Label>
              <Input
                id="debug-flags-user-search"
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t.debugFlags?.userSearchPlaceholder ?? 'Type name or username…'}
                disabled={loading.orgs || loading.action}
                data-testid="debug-flags-user-search"
              />
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t.debugFlags?.users ?? 'Active users'}
              </h2>
              {loading.users ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{t.debugFlags?.loadingUsers ?? 'Loading users…'}</span>
                </div>
              ) : users.length === 0 ? (
                <p className="text-muted-foreground">
                  {t.debugFlags?.noUsers ?? 'No active users found for this query.'}
                </p>
              ) : (
                <ul className="max-h-[420px] space-y-2 overflow-auto pr-1" data-testid="debug-flags-users-list">
                  {users.map(user => {
                    const selected = user.id === selectedUserId;
                    return (
                      <li key={user.id}>
                        <button
                          type="button"
                          className={cn(
                            'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition-colors',
                            selected
                              ? 'border-primary bg-primary/15 text-foreground'
                              : 'border-border bg-background/50 hover:bg-muted/60'
                          )}
                          onClick={() => handleSelectUser(user.id)}
                          data-testid={`debug-flags-user-row-${user.id}`}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{user.name}</span>
                            <span className="truncate text-xs text-muted-foreground">{user.username}</span>
                          </span>
                          <UserRound className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </article>

        <article className="flex flex-col gap-4 rounded-lg border border-border bg-card/70 p-4 shadow-sm">
          <div className="rounded-md border border-border/80 bg-background/40 p-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t.debugFlags?.currentStatus ?? 'Current status'}
            </h2>

            {!selectedTarget ? (
              <p className="mt-2 text-muted-foreground">
                {t.debugFlags?.selectTargetHint ?? 'Select a special target or an active user to inspect and configure debug flags.'}
              </p>
            ) : loading.status ? (
              <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.loading}</span>
              </div>
            ) : status?.targetAvailable === false ? (
              <div className="mt-2 space-y-2">
                <p>
                  <span className="font-semibold">{t.debugFlags?.selectedTarget ?? 'Selected target'}:</span>{' '}
                  <span data-testid="debug-flags-selected-target-label">{selectedTargetLabel}</span>
                </p>
                <p className="text-amber-300" data-testid="debug-flags-target-unavailable">
                  {status.unavailableReason ?? t.debugFlags?.targetUnavailable ?? 'This trace flag target is not available in this org.'}
                </p>
              </div>
            ) : status?.traceFlagId ? (
              <div className="mt-2 space-y-2">
                <p>
                  <span className="font-semibold">{t.debugFlags?.selectedTarget ?? 'Selected target'}:</span>{' '}
                  <span data-testid="debug-flags-selected-target-label">{selectedTargetLabel}</span>
                </p>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold',
                      status.isActive
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-zinc-500/20 text-zinc-300'
                    )}
                    data-testid="debug-flags-status-pill"
                  >
                    {status.isActive
                      ? t.debugFlags?.statusActive ?? 'Active'
                      : t.debugFlags?.statusInactive ?? 'Inactive'}
                  </span>
                </div>
                <p>
                  <span className="font-semibold">{t.debugFlags?.statusLevel ?? 'Debug level'}:</span>{' '}
                  <span data-testid="debug-flags-status-level">{status.debugLevelName || '-'}</span>
                </p>
                <p>
                  <span className="font-semibold">{t.debugFlags?.statusStart ?? 'Starts'}:</span>{' '}
                  {formatDate(status.startDate, locale)}
                </p>
                <p>
                  <span className="font-semibold">{t.debugFlags?.statusExpiration ?? 'Expires'}:</span>{' '}
                  <span data-testid="debug-flags-status-expiration">
                    {formatDate(status.expirationDate, locale)}
                  </span>
                </p>
              </div>
            ) : (
              <div className="mt-2 space-y-2 text-muted-foreground">
                <p>
                  <span className="font-semibold">{t.debugFlags?.selectedTarget ?? 'Selected target'}:</span>{' '}
                  <span className="text-foreground" data-testid="debug-flags-selected-target-label">
                    {selectedTargetLabel}
                  </span>
                </p>
                <p>{t.debugFlags?.noStatus ?? 'No active USER_DEBUG trace flag for this target.'}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
            <LabeledSelect
              label={t.debugFlags?.debugLevel ?? 'Debug level'}
              value={debugLevel}
              onChange={setDebugLevel}
              options={debugLevels.map(level => ({ value: level, label: level }))}
              placeholderLabel={t.tail?.select ?? 'Select'}
              disabled={loading.orgs || loading.action}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="debug-flags-ttl">
                {t.debugFlags?.ttlMinutes ?? 'TTL (minutes)'}
              </Label>
              <Input
                id="debug-flags-ttl"
                type="number"
                value={ttlMinutes}
                onChange={event => setTtlMinutes(event.target.value)}
                min={1}
                max={1440}
                disabled={loading.orgs || loading.action}
                data-testid="debug-flags-ttl"
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t.debugFlags?.ttlHelper ?? 'Default is 30 minutes. Allowed range: 1-1440.'}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleApply}
              disabled={!canApply}
              variant="secondary"
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
                  variant="outline"
                  disabled={loading.orgs || loading.action}
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
                        disabled={loading.orgs || loading.action}
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
                        disabled={loading.orgs || loading.action}
                      >
                        {t.logsCleanup?.deleteAll ?? 'Delete all org logs'}
                      </Button>
                    </Popover.Close>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </article>
      </section>

      <section
        className="rounded-lg border border-border bg-card/70 p-4 shadow-sm"
        data-testid="debug-level-manager"
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">
            {t.debugFlags?.managerTitle ?? 'Debug Level Manager'}
          </h2>
          <p className="text-sm text-muted-foreground">
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
            <Label htmlFor="debug-level-preset-select">
              {t.debugFlags?.managerPreset ?? 'Preset'}
            </Label>
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
            <Label htmlFor="debug-level-draft-language">
              {t.debugFlags?.managerLanguage ?? 'Language'}
            </Label>
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

      {error && (
        <div
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
          data-testid="debug-flags-error"
        >
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!error && notice && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-2',
            notice.tone === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : notice.tone === 'warning'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                : 'border-sky-500/30 bg-sky-500/10 text-sky-300'
          )}
          data-testid="debug-flags-notice"
        >
          <NoticeIcon className="h-4 w-4" aria-hidden="true" />
          <span>{notice.message}</span>
        </div>
      )}
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
