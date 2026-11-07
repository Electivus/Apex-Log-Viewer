import React from 'react';
import { LabeledSelect } from './LabeledSelect';

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel?: string;
};

export function FilterSelect({ label, value, onChange, options, allLabel = 'All' }: Props) {
  return (
    <LabeledSelect
      label={label}
      value={value}
      onChange={onChange}
      options={options.map(o => ({ value: o, label: o }))}
      placeholderLabel={allLabel}
      triggerClassName="min-w-[160px]"
    />
  );
}
