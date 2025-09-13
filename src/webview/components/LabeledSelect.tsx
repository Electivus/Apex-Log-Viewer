import React from 'react';
import type ReactNS from 'react';

export type LabeledSelectOption = {
  value: string;
  label: string;
};

type LabeledSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: LabeledSelectOption[];
  disabled?: boolean;
  // When provided, renders a first option with empty value
  // Useful for filters with an "All" choice
  placeholderLabel?: string;
  // If true and there are no options, render `emptyText` instead of a select
  hideIfEmpty?: boolean;
  emptyText?: string;
  // Allow minor style overrides (e.g., minWidth)
  selectStyleOverride?: ReactNS.CSSProperties;
};

export function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
  placeholderLabel,
  hideIfEmpty = false,
  emptyText,
  selectStyleOverride
}: LabeledSelectProps) {
  if (hideIfEmpty && options.length === 0) {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ opacity: 0.8 }}>{label}:</span>
        <span style={{ opacity: 0.7 }} aria-live="polite">
          {emptyText || 'No options available.'}
        </span>
      </label>
    );
  }

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ opacity: 0.8 }}>{label}:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="alv-select"
        style={selectStyleOverride}
      >
        {typeof placeholderLabel === 'string' && (
          <option value="">{placeholderLabel}</option>
        )}
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

