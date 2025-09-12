import React from 'react';
import type { OrgItem } from '../../shared/types';
import { selectStyle } from './styles';

export function OrgSelect({
  label,
  orgs,
  selected,
  onChange,
  disabled = false,
  emptyText
}: {
  label: string;
  orgs: OrgItem[];
  selected?: string;
  onChange: (username: string) => void;
  disabled?: boolean;
  emptyText?: string;
}) {
  const value = selected ?? (orgs[0]?.username || '');
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ opacity: 0.8 }}>{label}:</span>
      {orgs.length > 0 ? (
        <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} style={selectStyle}>
          {orgs.map(o => (
            <option key={o.username} value={o.username}>
              {(o.alias ?? o.username) + (o.isDefaultUsername ? ' *' : '')}
            </option>
          ))}
        </select>
      ) : (
        <span style={{ opacity: 0.7 }} aria-live="polite">
          {emptyText || 'No orgs detected.'}
        </span>
      )}
    </label>
  );
}

