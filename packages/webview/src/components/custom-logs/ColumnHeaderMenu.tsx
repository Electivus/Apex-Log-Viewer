import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Ellipsis } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from '../../utils/customLogs/format';

type ColumnHeaderMenuProps = {
  t: CustomLogsMessages;
  column: string;
  /** Pinned by the project mapping: hidden for this user instead of removed. */
  locked: boolean;
  onSort: (dir: 'asc' | 'desc') => void;
  onFilter: () => void;
  onRemove: () => void;
};

const ITEM_CLASS = 'block w-full px-3.5 py-1 text-left text-xs hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none';

/** The `...` menu of a JSON column header: sort, filter by the field, remove. */
export function ColumnHeaderMenu({ t, column, locked, onSort, onFilter, onRemove }: ColumnHeaderMenuProps) {
  const choose = (action: () => void) => () => action();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={fillTemplate(t.table.columnMenu, { column })}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-foreground/15 hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100 data-[state=open]:opacity-100"
          onClick={event => event.stopPropagation()}
        >
          <Ellipsis className="h-3 w-3" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          role="menu"
          className="z-50 min-w-[190px] rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg outline-none"
        >
          <Popover.Close asChild>
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={choose(() => onSort('asc'))}>
              {t.menu.sortAscending}
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={choose(() => onSort('desc'))}>
              {t.menu.sortDescending}
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={choose(onFilter)}>
              {t.menu.filterBy}
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={choose(onRemove)}>
              {locked ? t.menu.hide : t.menu.remove}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
