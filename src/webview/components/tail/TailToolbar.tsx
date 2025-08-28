import React from 'react';
import type { OrgItem } from '../../../shared/types';

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
  const buttonStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid var(--vscode-button-border, transparent)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    cursor: 'pointer'
  };

  const selectStyle: React.CSSProperties = {
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
    padding: '2px 6px',
    borderRadius: 4
  };

  const inputStyle: React.CSSProperties = {
    minWidth: 140,
    padding: '4px 8px',
    borderRadius: 4,
    border: '1px solid var(--vscode-input-border)',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)'
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button onClick={running ? onStop : onStart} style={buttonStyle} disabled={disabled}>
        {running ? t.tail?.stop ?? 'Stop' : t.tail?.start ?? 'Start'}
      </button>
      <button onClick={onClear} style={buttonStyle} disabled={disabled}>
        {t.tail?.clear ?? 'Clear'}
      </button>
      <button
        onClick={onOpenSelected}
        style={buttonStyle}
        disabled={disabled || !actionsEnabled}
        title={t.tail?.openSelectedLogTitle ?? 'Open selected log'}
      >
        {t.tail?.openLog ?? 'Open Log'}
      </button>
      <button
        onClick={onReplaySelected}
        style={buttonStyle}
        disabled={disabled || !actionsEnabled}
        title={t.tail?.replayDebuggerTitle ?? 'Apex Replay Debugger'}
      >
        {t.tail?.replayDebugger ?? 'Replay Debugger'}
      </button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ opacity: 0.8 }}>{t.orgLabel}:</span>
        <select
          value={selectedOrg ?? (orgs[0]?.username || '')}
          onChange={e => onSelectOrg(e.target.value)}
          disabled={disabled}
          style={selectStyle}
        >
          {orgs.map(o => (
            <option key={o.username} value={o.username}>
              {(o.alias ?? o.username) + (o.isDefaultUsername ? ' *' : '')}
            </option>
          ))}
        </select>
      </label>
      <input
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder={t.tail?.searchLivePlaceholder ?? 'Search live logs…'}
        disabled={disabled}
        style={{ ...inputStyle, flex: '1 1 220px', minWidth: 160 }}
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{t.tail?.debugLevel ?? 'Debug level'}</span>
        <select
          value={debugLevel}
          onChange={e => onDebugLevelChange(e.target.value)}
          disabled={disabled}
          style={{ ...selectStyle, minWidth: 140 }}
        >
          <option value="">{t.tail?.select ?? 'Select'}</option>
          {debugLevels.map(level => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
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
