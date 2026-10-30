import React from 'react';
import { TriangleAlert } from 'lucide-react';
import type { CustomLogPayloadView } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { formatScalar, scalarKind } from '../../utils/customLogs/format';
import { payloadValues } from '../../utils/customLogs/payloadRows';

/**
 * One JSON path of a row or entry. A payload that did not parse says why on the first payload column
 * (`marker`), and a path the payload lacks is a dash.
 */
export function PayloadCell({
  t,
  payload,
  path,
  marker
}: {
  t: CustomLogsMessages;
  payload: CustomLogPayloadView | undefined;
  path: string;
  marker: boolean;
}) {
  const values = payloadValues(payload, path);
  if (values.length > 0) {
    const single = values.length === 1 ? values[0]! : undefined;
    const kind = single === undefined ? 'string' : scalarKind(single);
    const text = values.map(formatScalar).join(', ');
    return (
      <span
        title={text}
        className={cn(
          'block truncate font-mono text-xs',
          kind === 'number' && 'text-right text-[color:var(--vscode-debugTokenExpression-number,#b5cea8)]',
          kind === 'boolean' && 'text-[color:var(--vscode-debugTokenExpression-boolean,#569cd6)]',
          kind === 'null' && 'italic text-muted-foreground'
        )}
      >
        {text}
      </span>
    );
  }
  const state = payload?.state;
  if (marker && state && state !== 'parsed') {
    return (
      <span
        className={cn(
          'flex items-center gap-1 text-[11px]',
          state === 'empty' ? 'text-muted-foreground' : 'text-amber-400'
        )}
        title={t.payload[`${state}Note`]}
      >
        {state === 'empty' ? null : <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {t.payload[state]}
      </span>
    );
  }
  return <span className="text-muted-foreground/60">—</span>;
}
