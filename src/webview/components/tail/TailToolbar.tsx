import React from 'react';
import { ExternalLink, Loader2, Play, Redo2, Square, Trash2 } from 'lucide-react';
import type { OrgItem } from '../../../shared/types';
import { LabeledSelect } from '../LabeledSelect';
import { OrgSelect } from '../OrgSelect';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';

type TailToolbarProps = {
  running: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onOpenSelected: () => void;
  onReplaySelected: () => void;
  actionsEnabled: boolean;
  // Disable all controls while loading/busy
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
  const debugOnlyId = React.useId();
  const colorizeId = React.useId();
  const autoScrollId = React.useId();

  return (
    <div className="flex flex-wrap items-center gap-2 md:gap-3">
      <Button
        onClick={running ? onStop : onStart}
        disabled={disabled}
        variant={running ? 'destructive' : 'default'}
        className="min-w-[90px]"
      >
        {running ? (
          <span className="flex items-center gap-2">
            <Square className="h-4 w-4" aria-hidden />
            {t.tail?.stop ?? 'Stop'}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Play className="h-4 w-4" aria-hidden />
            {t.tail?.start ?? 'Start'}
          </span>
        )}
      </Button>
      <Button onClick={onClear} disabled={disabled} variant="outline" className="min-w-[90px]">
        <span className="flex items-center gap-2">
          <Trash2 className="h-4 w-4" aria-hidden />
          {t.tail?.clear ?? 'Clear'}
        </span>
      </Button>
      <Button
        onClick={onOpenSelected}
        disabled={disabled || !actionsEnabled}
        title={t.tail?.openSelectedLogTitle ?? 'Open selected log'}
        variant="secondary"
        className="min-w-[150px]"
      >
        {disabled && actionsEnabled ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t.tail?.openLog ?? 'Open Log'}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4" aria-hidden />
            {t.tail?.openLog ?? 'Open Log'}
          </span>
        )}
      </Button>
      <Button
        onClick={onReplaySelected}
        disabled={disabled || !actionsEnabled}
        title={t.tail?.replayDebuggerTitle ?? 'Apex Replay Debugger'}
        variant="secondary"
        className="min-w-[160px]"
      >
        <span className="flex items-center gap-2">
          <Redo2 className="h-4 w-4" aria-hidden />
          {t.tail?.replayDebugger ?? 'Replay Debugger'}
        </span>
      </Button>
      <OrgSelect
        label={t.orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        disabled={disabled}
        emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
      />
      <Input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.tail?.searchLivePlaceholder ?? 'Search live logs…'}
        disabled={disabled}
        className="min-w-[11rem] flex-1"
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id={debugOnlyId}
          checked={onlyUserDebug}
          onCheckedChange={val => onToggleOnlyUserDebug(Boolean(val))}
          disabled={disabled}
        />
        <Label htmlFor={debugOnlyId}>{t.tail?.debugOnly ?? 'Debug Only'}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={colorizeId}
          checked={colorize}
          onCheckedChange={val => onToggleColorize(Boolean(val))}
          disabled={disabled}
        />
        <Label htmlFor={colorizeId}>{t.tail?.colorize ?? 'Color'}</Label>
      </div>
      <LabeledSelect
        label={t.tail?.debugLevel ?? 'Debug level'}
        value={debugLevel}
        onChange={onDebugLevelChange}
        disabled={disabled}
        options={debugLevels.map(level => ({ value: level, label: level }))}
        placeholderLabel={t.tail?.select ?? 'Select'}
        selectStyleOverride={{ minWidth: 140 }}
      />
      <div className="ml-auto flex items-center gap-2">
        <Checkbox
          id={autoScrollId}
          checked={autoScroll}
          onCheckedChange={val => onToggleAutoScroll(Boolean(val))}
          disabled={disabled}
        />
        <Label htmlFor={autoScrollId}>{t.tail?.autoScroll ?? 'Auto-scroll'}</Label>
      </div>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  );
}
