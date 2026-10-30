import React from 'react';
import type { OrgItem } from '@alv/protocol/types';
import { LabeledSelect } from './LabeledSelect';

export function OrgSelect({
  label,
  orgs,
  selected,
  onChange,
  testId,
  disabled = false,
  emptyText,
  className
}: {
  label: string;
  orgs: OrgItem[];
  selected?: string;
  onChange: (username: string) => void;
  testId?: string;
  disabled?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const options = orgs.map(o => ({
    value: o.username,
    label: o.alias ?? o.username
  }));
  const value = selected ?? '';
  return (
    <LabeledSelect
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      testId={testId}
      disabled={disabled}
      hideIfEmpty
      emptyText={emptyText || 'No orgs detected.'}
      className={className}
      triggerClassName="min-w-[220px]"
    />
  );
}
