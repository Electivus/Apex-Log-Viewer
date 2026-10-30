import React from 'react';
import type { CustomLogScalar } from '@alv/protocol/customLogsTypes';

/** A mapped SObject field. A null record field is empty, unlike a JSON payload `null`, which is a value. */
export function ExtraCell({ value }: { value: CustomLogScalar | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  const text = String(value);
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}
