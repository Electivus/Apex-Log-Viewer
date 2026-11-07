import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { OrgItem } from '@alv/protocol/types';
import { getMessages } from '../i18n';
import { cn } from '../lib/utils';
import { filterOrgs, toOrgOption } from '../utils/orgFilter';
import { Label } from './ui/label';

/** The search box appears once the list is longer than this; a handful of orgs is quicker to scan. */
const SEARCH_THRESHOLD = 5;

function pickerMessages() {
  const lang = typeof document === 'undefined' ? undefined : document.documentElement.lang;
  return getMessages(lang).orgPicker;
}

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
  const baseId = React.useId();
  const labelId = `${baseId}-label`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const searchable = orgs.length > SEARCH_THRESHOLD;
  const visible = React.useMemo(() => filterOrgs(orgs, searchable ? query : ''), [orgs, query, searchable]);
  const options = React.useMemo(() => visible.map(toOrgOption), [visible]);

  React.useEffect(() => {
    if (open) {
      document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [baseId, open, activeIndex, options]);

  if (orgs.length === 0) {
    return (
      <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</Label>
        <span className="text-sm text-muted-foreground/80" aria-live="polite">
          {emptyText || 'No orgs detected.'}
        </span>
      </div>
    );
  }

  const t = pickerMessages();
  const current = orgs.find(o => o.username === selected) ?? (selected ? undefined : orgs[0]);
  const currentLabel = current ? toOrgOption(current).primary : (selected ?? '');

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery('');
      setActiveIndex(
        Math.max(
          0,
          orgs.findIndex(o => o.username === selected)
        )
      );
    }
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) {
      return;
    }
    setOpen(false);
    if (option.value !== selected) {
      onChange(option.value);
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent) => {
    // Enter during IME composition confirms the text, it does not choose an org.
    if (event.nativeEvent.isComposing) {
      return;
    }
    const last = options.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActiveIndex(i => Math.min(i + 1, last));
        break;
      case 'ArrowUp':
        setActiveIndex(i => Math.max(i - 1, 0));
        break;
      case 'Home':
      case 'End':
        if (searchable) {
          return;
        }
        setActiveIndex(event.key === 'Home' ? 0 : Math.max(last, 0));
        break;
      case 'Enter':
        choose(activeIndex);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      handleOpenChange(true);
    }
  };

  return (
    <div className={cn('flex min-w-[160px] flex-col gap-1', className)}>
      <Label id={labelId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-labelledby={labelId}
            data-testid={testId}
            disabled={disabled}
            onKeyDown={handleTriggerKeyDown}
            className="flex min-h-[28px] w-full min-w-[8rem] max-w-[16rem] items-center justify-between gap-2 rounded-md border border-input bg-input px-3 py-1 text-left text-[13px] ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="min-w-0 truncate">{currentLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            role="presentation"
            align="start"
            sideOffset={4}
            collisionPadding={8}
            onOpenAutoFocus={event => {
              event.preventDefault();
              (searchable ? searchRef.current : listRef.current)?.focus();
            }}
            onKeyDown={handleListKeyDown}
            className="z-50 flex w-[max(var(--radix-popover-trigger-width),20rem)] max-w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none"
            style={{ maxHeight: 'min(18rem, var(--radix-popover-content-available-height))' }}
          >
            {searchable && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-2">
                <Search className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  role="searchbox"
                  aria-label={t.searchPlaceholder}
                  aria-controls={listboxId}
                  aria-activedescendant={options.length > 0 ? optionId(activeIndex) : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t.searchPlaceholder}
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={label}
              tabIndex={-1}
              aria-activedescendant={!searchable && options.length > 0 ? optionId(activeIndex) : undefined}
              className="min-h-0 flex-1 overflow-y-auto p-1 outline-none"
            >
              {options.length === 0 ? (
                <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t.noMatches}
                </div>
              ) : (
                options.map((option, index) => {
                  const isSelected = option.value === selected;
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={option.value}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      data-active={isActive || undefined}
                      onMouseDown={event => event.preventDefault()}
                      onMouseMove={() => !isActive && setActiveIndex(index)}
                      onClick={() => choose(index)}
                      className={cn(
                        'relative flex cursor-default select-none items-baseline gap-2 rounded-sm py-1 pl-6 pr-2 text-[13px]',
                        'data-[active]:bg-[var(--vscode-list-activeSelectionBackground,var(--muted))] data-[active]:text-[var(--vscode-list-activeSelectionForeground,inherit)]',
                        'data-[active]:outline data-[active]:outline-1 data-[active]:-outline-offset-1 data-[active]:outline-[color:var(--vscode-list-focusOutline,transparent)]'
                      )}
                    >
                      {isSelected && <Check className="absolute left-2 h-3.5 w-3.5 self-center" aria-hidden="true" />}
                      <span className="max-w-[65%] flex-none truncate">{option.primary}</span>
                      {option.secondary && (
                        <span className="min-w-0 flex-1 truncate text-xs opacity-70">{option.secondary}</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
