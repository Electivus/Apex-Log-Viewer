import React, { useId } from 'react';
import { Search } from 'lucide-react';
import type { CustomLogLevel } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';

type CustomLogViewerToolbarProps = {
  t: CustomLogsMessages;
  search: string;
  onSearchChange: (value: string) => void;
  levels: Array<{ level: CustomLogLevel; count: number }>;
  selectedLevels: ReadonlySet<CustomLogLevel>;
  onToggleLevel: (level: CustomLogLevel) => void;
  details: Array<{ key: string; count: number }>;
  selectedDetails: ReadonlySet<string>;
  onToggleDetail: (key: string) => void;
  systemCount: number;
  showSystem: boolean;
  onShowSystemChange: (value: boolean) => void;
};

const LEVEL_COLOR: Record<CustomLogLevel, string> = {
  ERROR: 'var(--vscode-charts-red, #f14c4c)',
  WARN: 'var(--vscode-charts-yellow, #cca700)',
  INFO: 'var(--vscode-charts-blue, #3794ff)',
  DEBUG: 'var(--vscode-charts-purple, #b180d7)',
  FINE: 'var(--vscode-descriptionForeground, #8b949e)',
  FINER: 'var(--vscode-descriptionForeground, #8b949e)',
  FINEST: 'var(--vscode-descriptionForeground, #8b949e)'
};

function ToggleChip({
  pressed,
  onToggle,
  color,
  children,
  title
}: {
  pressed: boolean;
  onToggle: () => void;
  color?: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium',
        pressed ? 'text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
      )}
      style={
        pressed && color
          ? { borderColor: color, background: `color-mix(in srgb, ${color} 22%, transparent)` }
          : pressed
            ? {
                borderColor: 'var(--vscode-focusBorder, #007fd4)',
                background: 'color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 22%, transparent)'
              }
            : undefined
      }
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

export function CustomLogViewerToolbar({
  t,
  search,
  onSearchChange,
  levels,
  selectedLevels,
  onToggleLevel,
  details,
  selectedDetails,
  onToggleDetail,
  systemCount,
  showSystem,
  onShowSystemChange
}: CustomLogViewerToolbarProps) {
  const systemId = useId();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={search}
          aria-label={t.viewer.search}
          placeholder={t.viewer.search}
          className="w-52 pl-7 text-xs"
          onChange={event => onSearchChange(event.target.value)}
        />
      </div>
      {levels.length > 0 ? (
        <div role="group" aria-label={t.viewer.levelFilter} className="flex flex-wrap items-center gap-1">
          {levels.map(({ level, count }) => (
            <ToggleChip
              key={level}
              pressed={selectedLevels.has(level)}
              color={LEVEL_COLOR[level]}
              onToggle={() => onToggleLevel(level)}
            >
              {level}
              <span className="text-muted-foreground">{count}</span>
            </ToggleChip>
          ))}
        </div>
      ) : null}
      {details.length > 0 ? (
        <div role="group" aria-label={t.viewer.detailFilter} className="flex flex-wrap items-center gap-1">
          {details.map(({ key, count }) => (
            <ToggleChip key={key} pressed={selectedDetails.has(key)} title={key} onToggle={() => onToggleDetail(key)}>
              <span className="font-mono">{key.replace(/__c$/, '')}</span>
              <span className="text-muted-foreground">{count}</span>
            </ToggleChip>
          ))}
        </div>
      ) : null}
      <span className="flex-1" />
      <div className="flex items-center gap-2">
        <Switch id={systemId} checked={showSystem} onCheckedChange={onShowSystemChange} />
        <Label
          htmlFor={systemId}
          className="cursor-pointer whitespace-nowrap text-xs font-normal text-muted-foreground"
        >
          {t.viewer.showSystem}
          {systemCount > 0 ? ` (${systemCount})` : ''}
        </Label>
      </div>
    </div>
  );
}
