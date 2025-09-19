import React from 'react';
import type ReactNS from 'react';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { cn } from '../utils/cn';

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
  const triggerId = React.useId();
  const shouldUseNativeSelect = React.useMemo(() => {
    try {
      if (typeof document === 'undefined') {
        return true;
      }
      const testEl = document.createElement('div');
      return typeof testEl.setPointerCapture !== 'function';
    } catch {
      return true;
    }
  }, []);
  if (hideIfEmpty && options.length === 0) {
    return (
      <div className="flex items-center gap-2" aria-live="polite">
        <Label className="text-muted-foreground">{label}:</Label>
        <span className="text-xs text-muted-foreground/80">{emptyText || 'No options available.'}</span>
      </div>
    );
  }

  const hasPlaceholder = typeof placeholderLabel === 'string' && placeholderLabel.length > 0;
  const placeholderValue = '__placeholder__';
  const selectValue = hasPlaceholder && (!value || value === placeholderValue) ? placeholderValue : value;

  const handleChange = (next: string) => {
    if (hasPlaceholder && next === placeholderValue) {
      onChange('');
    } else {
      onChange(next);
    }
  };

  if (shouldUseNativeSelect) {
    return (
      <label className="flex items-center gap-2" htmlFor={triggerId}>
        <span className="text-muted-foreground">{label}:</span>
        <select
          id={triggerId}
          value={selectValue}
          onChange={e => handleChange(e.target.value)}
          disabled={disabled}
          className={cn(
            'w-40 min-w-[8rem] rounded-md border border-input bg-input px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ring-offset-background',
            disabled && 'opacity-80'
          )}
          style={selectStyleOverride}
        >
          {hasPlaceholder && <option value={placeholderValue}>{placeholderLabel}</option>}
          {options.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Label className="text-muted-foreground" htmlFor={triggerId}>
        {label}:
      </Label>
      <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
          id={triggerId}
          className={cn('w-40 min-w-[8rem]', disabled && 'opacity-80')}
          style={selectStyleOverride}
        >
          <SelectValue placeholder={placeholderLabel} />
        </SelectTrigger>
        <SelectContent>
          {hasPlaceholder && <SelectItem value={placeholderValue}>{placeholderLabel}</SelectItem>}
          {options.map(o => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
