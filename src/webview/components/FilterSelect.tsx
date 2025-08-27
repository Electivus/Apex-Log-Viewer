import React from 'react';

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel?: string;
  disabled?: boolean;
};

export function FilterSelect({ label, value, onChange, options, allLabel = 'All', disabled = false }: Props) {
  const selectStyle: React.CSSProperties = {
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
    padding: '2px 6px',
    borderRadius: 4
  };

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ opacity: 0.8 }}>{label}:</span>
      <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle} disabled={disabled}>
        <option value="">{allLabel}</option>
        {options.map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
