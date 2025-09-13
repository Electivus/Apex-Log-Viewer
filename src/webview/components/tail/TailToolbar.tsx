import React from 'react';
import type { OrgItem } from '../../../shared/types';
import { LabeledSelect } from '../LabeledSelect';
import { OrgSelect } from '../OrgSelect';
import { SpinnerIcon } from '../icons/ReplayIcon';

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
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button onClick={running ? onStop : onStart} className="alv-button" disabled={disabled}>
        {running ? (t.tail?.stop ?? 'Stop') : (t.tail?.start ?? 'Start')}
      </button>
      <button onClick={onClear} className="alv-button" disabled={disabled}>
        {t.tail?.clear ?? 'Clear'}
      </button>
      <button
        onClick={onOpenSelected}
        className="alv-button"
        disabled={disabled || !actionsEnabled}
        title={t.tail?.openSelectedLogTitle ?? 'Open selected log'}
      >
        {disabled && actionsEnabled ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SpinnerIcon />
            {t.tail?.openLog ?? 'Open Log'}
          </span>
        ) : (
          t.tail?.openLog ?? 'Open Log'
        )}
      </button>
      <button
        onClick={onReplaySelected}
        className="alv-button"
        disabled={disabled || !actionsEnabled}
        title={t.tail?.replayDebuggerTitle ?? 'Apex Replay Debugger'}
      >
        {t.tail?.replayDebugger ?? 'Replay Debugger'}
      </button>
      <OrgSelect
        label={t.orgLabel}
        orgs={orgs}
        selected={selectedOrg}
        onChange={onSelectOrg}
        disabled={disabled}
        emptyText={t.noOrgsDetected ?? 'No orgs detected. Run "sf org list".'}
      />
      <input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.tail?.searchLivePlaceholder ?? 'Search live logs…'}
        disabled={disabled}
        className="alv-input"
        style={{ flex: '1 1 220px', minWidth: 160 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={onlyUserDebug}
          onChange={e => onToggleOnlyUserDebug(e.target.checked)}
          disabled={disabled}
        />
        <span>{t.tail?.debugOnly ?? 'Debug Only'}</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={colorize}
          onChange={e => onToggleColorize(e.target.checked)}
          disabled={disabled}
        />
        <span>{t.tail?.colorize ?? 'Color'}</span>
      </label>
      <LabeledSelect
        label={t.tail?.debugLevel ?? 'Debug level'}
        value={debugLevel}
        onChange={onDebugLevelChange}
        disabled={disabled}
        options={debugLevels.map(level => ({ value: level, label: level }))}
        placeholderLabel={t.tail?.select ?? 'Select'}
        selectStyleOverride={{ minWidth: 140 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <input
          type="checkbox"
          checked={autoScroll}
          onChange={e => onToggleAutoScroll(e.target.checked)}
          disabled={disabled}
        />
        <span>{t.tail?.autoScroll ?? 'Auto-scroll'}</span>
      </label>
      {error && <span style={{ color: 'var(--vscode-errorForeground)' }}>{error}</span>}
    </div>
  );
}
