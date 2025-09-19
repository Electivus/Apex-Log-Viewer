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

  return (
    <div className="flex items-center gap-2">
      <Label className="text-muted-foreground">{label}:</Label>
      <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
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
