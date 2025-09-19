import React from 'react';
import {
  Play,
  Square,
  Eraser,
  ExternalLink,
  RotateCcw,
  Loader2
} from 'lucide-react';
import type { OrgItem } from '../../../shared/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { LabeledSelect } from '../LabeledSelect';
import { OrgSelect } from '../OrgSelect';

function useStableId(prefix: string) {
  const id = React.useId();
  return `${prefix}-${id}`;
}

type TailToolbarProps = {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onOpenSelected: () => void;
  onReplaySelected: () => void;
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
  t: any;
};

export function TailToolbar({
  running,
  onStart,
  onStop,
  onClear,
  onOpenSelected,
  onReplaySelected,
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
  const searchInputId = useStableId('tail-search');
  const userDebugId = useStableId('tail-user-debug');
  const colorizeId = useStableId('tail-colorize');
  const autoScrollId = useStableId('tail-autoscroll');
  const startStopLabel = running ? t.tail?.stop ?? 'Stop' : t.tail?.start ?? 'Start';

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card/60 p-4 shadow-sm">
      <div className="flex w-full flex-wrap items-end gap-3">
        <Button
          type="button"
          onClick={running ? onStop : onStart}
          disabled={disabled}
          variant={running ? 'destructive' : 'secondary'}
          className="flex items-center gap-2"
        >
          {running ? (
            <Square className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{startStopLabel}</span>
        </Button>

        <Button
          type="button"
          onClick={onClear}
          disabled={disabled}
          variant="outline"
          className="flex items-center gap-2"
        >
          <Eraser className="h-4 w-4" aria-hidden="true" />
          <span>{t.tail?.clear ?? 'Clear'}</span>
        </Button>

        <Button
          type="button"
          onClick={onOpenSelected}
          disabled={disabled || !actionsEnabled}
          variant="ghost"
          className="flex items-center gap-2"
          title={t.tail?.openSelectedLogTitle ?? 'Open selected log'}
        >
          {disabled && actionsEnabled ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{t.tail?.openLog ?? 'Open Log'}</span>
        </Button>

        <Button
          type="button"
          onClick={onReplaySelected}
          disabled={disabled || !actionsEnabled}
          variant="ghost"
          className="flex items-center gap-2"
          title={t.tail?.replayDebuggerTitle ?? 'Apex Replay Debugger'}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          <span>{t.tail?.replayDebugger ?? 'Replay Debugger'}</span>
        </Button>

        <OrgSelect
          label={t.orgLabel}
          orgs={orgs}
          selected={selectedOrg}
          onChange={onSelectOrg}
          disabled={disabled}
          emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
        />

        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <Label htmlFor={searchInputId}>{t.tail?.searchLivePlaceholder ?? 'Search live logs…'}</Label>
          <Input
            id={searchInputId}
            type="search"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={t.tail?.searchLivePlaceholder ?? 'Search live logs…'}
            disabled={disabled}
          />
        </div>

        <LabeledSelect
          label={t.tail?.debugLevel ?? 'Debug level'}
          value={debugLevel}
          onChange={onDebugLevelChange}
          disabled={disabled}
          options={debugLevels.map(level => ({ value: level, label: level }))}
          placeholderLabel={t.tail?.select ?? 'Select'}
          triggerClassName="min-w-[160px]"
        />
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Switch
            id={userDebugId}
            disabled={disabled}
            checked={onlyUserDebug}
            onCheckedChange={onToggleOnlyUserDebug}
          />
          <Label htmlFor={userDebugId}>{t.tail?.debugOnly ?? 'Debug Only'}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={colorizeId}
            disabled={disabled}
            checked={colorize}
            onCheckedChange={onToggleColorize}
          />
          <Label htmlFor={colorizeId}>{t.tail?.colorize ?? 'Color'}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={autoScrollId}
            disabled={disabled}
            checked={autoScroll}
            onCheckedChange={onToggleAutoScroll}
          />
          <Label htmlFor={autoScrollId}>{t.tail?.autoScroll ?? 'Auto-scroll'}</Label>
        </div>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    </section>
  );
}
