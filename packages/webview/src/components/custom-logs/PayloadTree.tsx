import React, { useMemo } from 'react';
import type { CustomLogScalar } from '@alv/protocol/customLogsTypes';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { formatScalar, scalarKind } from '../../utils/customLogs/format';
import { buildPayloadTree, type PayloadTreeNode } from '../../utils/customLogs/payloadRows';
import { Button } from '../ui/button';

type PayloadTreeProps = {
  t: CustomLogsMessages['payload'];
  values: Record<string, CustomLogScalar>;
  /** Paths that are columns right now, and the ones the project mapping pins. */
  columns: ReadonlySet<string>;
  lockedColumns: ReadonlySet<string>;
  /** Raw paths whose string core cut at its character limit. */
  cutValues: readonly string[];
  onToggleColumn: (path: string) => void;
  onFilterEqual: (path: string, value: CustomLogScalar) => void;
};

const VALUE_TONE: Record<ReturnType<typeof scalarKind>, string> = {
  string: 'text-[color:var(--vscode-debugTokenExpression-string,#ce9178)]',
  number: 'text-[color:var(--vscode-debugTokenExpression-number,#b5cea8)]',
  boolean: 'text-[color:var(--vscode-debugTokenExpression-boolean,#569cd6)]',
  null: 'italic text-muted-foreground'
};

export function PayloadTree({
  t,
  values,
  columns,
  lockedColumns,
  cutValues,
  onToggleColumn,
  onFilterEqual
}: PayloadTreeProps) {
  const tree = useMemo(() => buildPayloadTree(values), [values]);
  const cut = useMemo(() => new Set(cutValues), [cutValues]);

  const renderNode = (node: PayloadTreeNode): React.ReactNode => {
    if (node.kind === 'group') {
      return (
        <details key={node.key} open className="ml-0">
          <summary className="cursor-pointer select-none font-mono text-xs leading-[22px] text-[color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe)]">
            {node.key}
          </summary>
          <div className="ml-3.5">{node.children.map(renderNode)}</div>
        </details>
      );
    }
    const isColumn = columns.has(node.path);
    const isLocked = lockedColumns.has(node.path);
    const kind = scalarKind(node.value);
    return (
      <div
        key={node.rawPath}
        data-testid={`payload-leaf-${node.rawPath}`}
        className="group flex min-h-[22px] items-center gap-2 pr-0.5 font-mono text-xs hover:bg-muted/40"
      >
        <span className="shrink-0 text-[color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe)]">{node.key}:</span>
        <span className={cn('min-w-0 flex-1 truncate', VALUE_TONE[kind])} title={formatScalar(node.value)}>
          {kind === 'string' ? JSON.stringify(node.value) : formatScalar(node.value)}
          {cut.has(node.rawPath) ? (
            <em className="ml-1 text-[10px] not-italic text-amber-400">({t.valueCut})</em>
          ) : null}
        </span>
        <span className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[18px] min-h-0 px-1.5 text-[11px]"
            title={isLocked ? t.columnLocked : node.path}
            disabled={isLocked}
            onClick={() => onToggleColumn(node.path)}
          >
            {isColumn ? t.columnAdded : t.addColumn}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[18px] min-h-0 px-1.5 text-[11px]"
            title={`${node.path} = ${formatScalar(node.value)}`}
            onClick={() => onFilterEqual(node.path, node.value)}
          >
            {t.filterEqual}
          </Button>
        </span>
      </div>
    );
  };

  return <div className="text-xs">{tree.map(renderNode)}</div>;
}
