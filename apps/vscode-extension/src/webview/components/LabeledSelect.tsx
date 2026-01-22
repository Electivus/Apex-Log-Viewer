import React from 'react';
import { cn } from '../lib/utils';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';

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
  placeholderLabel?: string;
  hideIfEmpty?: boolean;
  emptyText?: string;
  className?: string;
  triggerClassName?: string;
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
  className,
  triggerClassName
}: LabeledSelectProps) {
  const PLACEHOLDER_VALUE = '__radix_empty__';
  const canUseRadix =
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof DocumentFragment !== 'undefined' &&
    typeof HTMLElement !== 'undefined';
  const selectId = React.useId();
  if (hideIfEmpty && options.length === 0) {
    return (
      <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </Label>
        <span className="text-sm text-muted-foreground/80" aria-live="polite">
          {emptyText || 'No options available.'}
        </span>
      </div>
    );
  }

  const hasPlaceholder = typeof placeholderLabel === 'string';
  const fallbackValue = value || (hasPlaceholder ? '' : options[0]?.value ?? '');

  if (!canUseRadix) {
    return (
      <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
        <Label
          htmlFor={selectId}
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {label}
        </Label>
        <select
          id={selectId}
          value={fallbackValue}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className={cn(
            'min-w-[160px] rounded-md border border-input bg-input px-3 py-1 text-[13px] text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            triggerClassName
          )}
        >
          {hasPlaceholder && <option value="">{placeholderLabel}</option>}
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const normalizedValue = (() => {
    if (value) {
      return value;
    }
    if (hasPlaceholder) {
      return PLACEHOLDER_VALUE;
    }
    return options[0]?.value ?? undefined;
  })();

  const handleValueChange = (nextValue: string) => {
    if (nextValue === PLACEHOLDER_VALUE) {
      onChange('');
      return;
    }
    onChange(nextValue);
  };

  return (
    <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Select value={normalizedValue} onValueChange={handleValueChange} disabled={disabled}>
        <SelectTrigger className={cn('min-w-[160px]', triggerClassName)}>
          <SelectValue placeholder={placeholderLabel} />
        </SelectTrigger>
        <SelectContent>
          {hasPlaceholder && (
            <SelectItem value={PLACEHOLDER_VALUE}>{placeholderLabel}</SelectItem>
          )}
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
