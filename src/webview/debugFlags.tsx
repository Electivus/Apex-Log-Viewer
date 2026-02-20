import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '../shared/debugFlagsMessages';
import type { DebugFlagUser, UserTraceFlagStatus } from '../shared/debugFlagsTypes';
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
import { AlertCircle, CheckCircle2, Info, Loader2, UserRound } from 'lucide-react';

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
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<UserTraceFlagStatus | undefined>(undefined);
  const [debugLevels, setDebugLevels] = useState<string[]>([]);
  const [debugLevel, setDebugLevel] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState('30');
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<NoticeState | undefined>(undefined);
  const [initialized, setInitialized] = useState(false);
  const selectedUserIdRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState<LoadingState>({
    orgs: false,
    users: false,
    status: false,
    action: false
  });

  useEffect(() => {
    selectedUserIdRef.current = selectedUserId;
  }, [selectedUserId]);

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
        case 'debugFlagsUserStatus':
          if (msg.userId === selectedUserIdRef.current) {
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

  const selectedUser = useMemo(
    () => users.find(user => user.id === selectedUserId),
    [users, selectedUserId]
  );

  const canApply = Boolean(selectedUserId && debugLevel && !loading.action && !loading.orgs);
  const canRemove = Boolean(selectedUserId && !loading.action && !loading.orgs);

  const handleSelectOrg = (nextOrg: string) => {
    setSelectedOrg(nextOrg);
    setSelectedUserId(undefined);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectOrg', target: nextOrg });
  };

  const handleSelectUser = (userId: string) => {
    setSelectedUserId(userId);
    setStatus(undefined);
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({ type: 'debugFlagsSelectUser', userId });
  };

  const handleApply = () => {
    if (!selectedUserId || !debugLevel) {
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
      userId: selectedUserId,
      debugLevelName: debugLevel,
      ttlMinutes: Math.floor(ttl)
    });
  };

  const handleRemove = () => {
    if (!selectedUserId) {
      return;
    }
    setNotice(undefined);
    setError(undefined);
    vscode.postMessage({
      type: 'debugFlagsRemove',
      userId: selectedUserId
    });
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

          <div className="flex min-w-[260px] flex-1 flex-col gap-1">
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
        </div>
      </section>

      <section className="grid min-h-[420px] grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <article className="rounded-lg border border-border bg-card/70 p-3 shadow-sm">
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
            <ul className="max-h-[460px] space-y-2 overflow-auto pr-1" data-testid="debug-flags-users-list">
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
        </article>

        <article className="flex flex-col gap-4 rounded-lg border border-border bg-card/70 p-4 shadow-sm">
          <div className="rounded-md border border-border/80 bg-background/40 p-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t.debugFlags?.currentStatus ?? 'Current status'}
            </h2>

            {!selectedUser ? (
              <p className="mt-2 text-muted-foreground">
                {t.debugFlags?.selectUserHint ?? 'Select an active user to inspect and configure debug flags.'}
              </p>
            ) : loading.status ? (
              <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t.loading}</span>
              </div>
            ) : status ? (
              <div className="mt-2 space-y-2">
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
                  <span data-testid="debug-flags-status-level">{status.debugLevelName}</span>
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
              <p className="mt-2 text-muted-foreground">
                {t.debugFlags?.noStatus ?? 'No active USER_DEBUG trace flag for this user.'}
              </p>
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
          </div>
        </article>
      </section>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
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
