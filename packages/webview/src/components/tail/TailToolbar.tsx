import React from 'react';
import { Play, Square, Eraser, ExternalLink, RotateCcw, Loader2, Bug } from 'lucide-react';
import type { OrgItem } from '@alv/protocol/types';
import type { Messages } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { LabeledSelect } from '../LabeledSelect';
import { OrgSelect } from '../OrgSelect';

const INLINE_SELECT = 'min-w-0 flex-row items-center gap-2 [&>label]:whitespace-nowrap';

type TailToolbarProps = {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onOpenSelected: () => void;
  onReplaySelected: () => void;
  onOpenDebugFlags: () => void;
  actionsEnabled: boolean;
  disabled?: boolean;
  orgs: OrgItem[];
  selectedOrg?: string;
  onSelectOrg: (username: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  onlyUserDebug: boolean;
  onToggleOnlyUserDebug: (v: boolean) => void;
  colorize: boolean;
  onToggleColorize: (v: boolean) => void;
  debugLevels: string[];
  debugLevel: string;
  onDebugLevelChange: (v: string) => void;
  autoScroll: boolean;
  onToggleAutoScroll: (v: boolean) => void;
  error?: string;
  t: Messages;
};

export function TailToolbar({
  running,
  onStart,
  onStop,
  onClear,
  onOpenSelected,
  onReplaySelected,
  onOpenDebugFlags,
  actionsEnabled,
  disabled = false,
  orgs,
  selectedOrg,
  onSelectOrg,
  query,
  onQueryChange,
  onlyUserDebug,
  onToggleOnlyUserDebug,
  colorize,
  onToggleColorize,
  debugLevels,
  debugLevel,
  onDebugLevelChange,
  autoScroll,
  onToggleAutoScroll,
  error,
  t
}: TailToolbarProps) {
  const searchLabel = t.tail?.searchLivePlaceholder ?? 'Search live logs…';
  const startStopLabel = running ? (t.tail?.stop ?? 'Stop') : (t.tail?.start ?? 'Start');

  return (
    <>
      <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <Button
          type="button"
          onClick={running ? onStop : onStart}
          disabled={disabled}
          variant={running ? 'destructive' : 'default'}
          className="flex items-center gap-2"
        >
          {running ? (
            <Square className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{startStopLabel}</span>
        </Button>

        <Button type="button" onClick={onClear} disabled={disabled} variant="ghost" className="flex items-center gap-2">
          <Eraser className="h-4 w-4" aria-hidden="true" />
          <span>{t.tail?.clear ?? 'Clear'}</span>
        </Button>

        <OrgSelect
          label={t.orgLabel}
          orgs={orgs}
          selected={selectedOrg}
          onChange={onSelectOrg}
          disabled={disabled}
          emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
          className={INLINE_SELECT}
        />

        <LabeledSelect
          label={t.tail?.debugLevel ?? 'Debug level'}
          value={debugLevel}
          onChange={onDebugLevelChange}
          testId="tail-debug-level"
          disabled={disabled}
          options={debugLevels.map(level => ({ value: level, label: level }))}
          placeholderLabel={t.tail?.select ?? 'Select'}
          className={INLINE_SELECT}
          triggerClassName="min-w-[160px]"
        />

        <Input
          type="search"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          aria-label={searchLabel}
          placeholder={searchLabel}
          disabled={disabled}
          className="min-w-[160px] flex-1"
        />

        <ToolbarSwitch
          label={t.tail?.debugOnly ?? 'Debug Only'}
          checked={onlyUserDebug}
          onCheckedChange={onToggleOnlyUserDebug}
          disabled={disabled}
        />
        <ToolbarSwitch
          label={t.tail?.colorize ?? 'Color'}
          checked={colorize}
          onCheckedChange={onToggleColorize}
          disabled={disabled}
        />
        <ToolbarSwitch
          label={t.tail?.autoScroll ?? 'Auto-scroll'}
          checked={autoScroll}
          onCheckedChange={onToggleAutoScroll}
          disabled={disabled}
        />

        <Button
          type="button"
          onClick={onOpenSelected}
          disabled={disabled || !actionsEnabled}
          variant="ghost"
          size="icon"
          title={t.tail?.openSelectedLogTitle ?? 'Open selected log'}
          aria-label={t.tail?.openLog ?? 'Open Log'}
        >
          {disabled && actionsEnabled ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>

        <Button
          type="button"
          onClick={onReplaySelected}
          disabled={disabled || !actionsEnabled}
          variant="ghost"
          size="icon"
          title={t.tail?.replayDebuggerTitle ?? 'Apex Replay Debugger'}
          aria-label={t.tail?.replayDebugger ?? 'Replay Debugger'}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </Button>

        <Button
          type="button"
          onClick={onOpenDebugFlags}
          disabled={disabled}
          variant="ghost"
          className="flex items-center gap-2"
          title={t.debugFlags?.openTitle ?? 'Open debug flags editor'}
          data-testid="tail-open-debug-flags"
        >
          <Bug className="h-4 w-4" aria-hidden="true" />
          <span>{t.debugFlags?.open ?? 'Debug Flags'}</span>
        </Button>
      </section>
      {error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
    </>
  );
}

function ToolbarSwitch({
  label,
  checked,
  onCheckedChange,
  disabled
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled: boolean;
}) {
  const id = React.useId();
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Switch id={id} disabled={disabled} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id} className="whitespace-nowrap">
        {label}
      </Label>
    </div>
  );
}
