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

  const normalizedValue = value ?? '';

  return (
    <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Select value={normalizedValue} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={cn('min-w-[160px]', triggerClassName)}>
          <SelectValue placeholder={placeholderLabel} />
        </SelectTrigger>
        <SelectContent>
          {typeof placeholderLabel === 'string' && (
            <SelectItem value="">{placeholderLabel}</SelectItem>
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
