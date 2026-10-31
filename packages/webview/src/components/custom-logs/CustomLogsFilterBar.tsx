import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Cloud, ListFilter, Search, X } from 'lucide-react';
import type { CustomLogsMessages } from '../../i18n';
import { cn } from '../../lib/utils';
import { fillTemplate } from '../../utils/customLogs/format';
import { formatFilterField } from '../../utils/customLogs/filterGrammar';
import type { FilterSubmitResult } from '../../utils/customLogs/filterMessages';
import {
  acceptGuidedItem,
  computeGuidedStage,
  type GuidedContext,
  type GuidedField,
  type GuidedStage
} from '../../utils/customLogs/guidedFilter';

export type FilterChip = {
  key: string;
  /** `server` chips change the SOQL and reload; `loaded` chips only narrow the rows already loaded. */
  scope: 'server' | 'loaded';
  /** The chip as the filter text reads, for example `http.status >= 500`. */
  text: string;
  field: string;
  op: string;
  value?: string;
  /** Absent for a chip the user cannot remove, like the selected source. */
  onRemove?: () => void;
  /** Takes the chip out of the filter and returns the text to edit in the input. */
  onEdit?: () => string;
};

export type FilterBarPrefill = { text: string; nonce: number };

type CustomLogsFilterBarProps = {
  t: CustomLogsMessages;
  chips: FilterChip[];
  fields: GuidedField[];
  valuesFor: GuidedContext['valuesFor'];
  onSubmit: (text: string) => FilterSubmitResult;
  onAddColumn: (path: string) => void;
  /** Puts text in the input and focuses it, for example when a column menu asks to filter by its field. */
  prefill?: FilterBarPrefill;
  disabled?: boolean;
  /** The list reads stored events, so a `server` filter runs in core over the store and not in a Salesforce query. */
  stored?: boolean;
};

const TYPE_LABEL_KEY = {
  string: 'typeString',
  number: 'typeNumber',
  boolean: 'typeBoolean',
  mixed: 'typeMixed',
  null: 'typeNull'
} as const;

const TYPE_TONE: Record<keyof typeof TYPE_LABEL_KEY, string> = {
  string: 'text-[color:var(--vscode-debugTokenExpression-string,#ce9178)]',
  number: 'text-[color:var(--vscode-debugTokenExpression-number,#b5cea8)]',
  boolean: 'text-[color:var(--vscode-debugTokenExpression-boolean,#569cd6)]',
  mixed: 'text-amber-400',
  null: 'text-muted-foreground'
};

function stageItems(stage: GuidedStage): number {
  return stage.stage === 'field' || stage.stage === 'operator' || stage.stage === 'value' ? stage.items.length : 0;
}

export function CustomLogsFilterBar({
  t,
  chips,
  fields,
  valuesFor,
  onSubmit,
  onAddColumn,
  prefill,
  disabled = false,
  stored = false
}: CustomLogsFilterBarProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<{ message: string; position: number } | undefined>(undefined);

  const stage = useMemo(() => computeGuidedStage(text, { fields, valuesFor }), [text, fields, valuesFor]);
  const itemCount = stageItems(stage);

  useEffect(() => {
    setHighlight(stage.stage === 'value' ? -1 : 0);
  }, [stage.stage, text]);

  useEffect(() => {
    if (prefill) {
      setText(prefill.text);
      setError(undefined);
      inputRef.current?.focus();
    }
  }, [prefill]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const commit = (source: string) => {
    if (!source.trim()) {
      return;
    }
    const result = onSubmit(source);
    if (result.ok) {
      setText('');
      setError(undefined);
    } else {
      setText(source);
      setError({ message: result.message, position: result.position });
    }
  };

  const accept = (index: number) => {
    const accepted = acceptGuidedItem(stage, index);
    if (!accepted) {
      return;
    }
    if (accepted.commit) {
      commit(accepted.text);
    } else {
      setText(accepted.text);
      setError(undefined);
    }
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (itemCount > 0) {
          event.preventDefault();
          setOpen(true);
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setHighlight(current => (current + step + itemCount) % itemCount);
        }
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case 'Tab':
        if (open && highlight >= 0 && itemCount > 0 && !event.shiftKey) {
          event.preventDefault();
          accept(highlight);
        }
        break;
      case 'Enter': {
        event.preventDefault();
        if (event.shiftKey && stage.stage === 'field') {
          const item = stage.items[highlight >= 0 ? highlight : 0];
          if (item?.kind === 'payload') {
            onAddColumn(item.path);
            setText('');
            return;
          }
        }
        if (highlight >= 0 && highlight < itemCount) {
          accept(highlight);
        } else {
          commit(text);
        }
        break;
      }
    }
  };

  const hint = (() => {
    switch (stage.stage) {
      case 'field':
        return t.filter.stageField;
      case 'operator':
        return fillTemplate(t.filter.stageOperator, { field: formatFilterField(stage.field, stage.kind) });
      case 'value':
        return fillTemplate(t.filter.stageValue, { field: formatFilterField(stage.field, stage.kind), op: stage.op });
      case 'commit':
        return t.filter.stageCommit;
    }
  })();

  const showPopup =
    open && !disabled && (itemCount > 0 || stage.stage === 'value' || stage.stage === 'commit' || error);

  return (
    <div className="relative flex min-h-[34px] shrink-0 items-center gap-1.5 border-b border-border px-3 py-1">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 max-w-[65%] shrink-0 items-center gap-1.5 overflow-hidden">
        {chips.map(chip => (
          <FilterChipView
            key={chip.key}
            t={t}
            chip={chip}
            disabled={disabled}
            stored={stored}
            onEdit={editedText => {
              setText(editedText);
              setError(undefined);
              inputRef.current?.focus();
            }}
          />
        ))}
      </div>
      <input
        ref={inputRef}
        role="combobox"
        aria-label={t.filter.aria}
        aria-expanded={Boolean(showPopup)}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showPopup && highlight >= 0 && highlight < itemCount ? `${listId}-${highlight}` : undefined
        }
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        value={text}
        placeholder={t.filter.placeholder}
        className={cn(
          'h-[26px] min-w-[200px] flex-1 rounded-md border border-input bg-input px-2 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          error && 'border-destructive'
        )}
        onChange={event => {
          setText(event.target.value);
          setError(undefined);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showPopup ? (
        <div
          className="absolute left-3 top-[33px] z-40 max-w-[760px] min-w-[460px] rounded-md border border-border bg-popover py-0.5 text-popover-foreground shadow-lg"
          onMouseDown={event => event.preventDefault()}
        >
          <div className="border-b border-border px-2.5 py-1 text-[11px] text-muted-foreground">{hint}</div>
          {error ? (
            <div role="alert" className="px-2.5 py-1 text-xs text-destructive">
              ⚠ {error.message} {fillTemplate(t.errors.at, { position: error.position + 1 })}
            </div>
          ) : null}
          <ul id={listId} role="listbox" aria-label={t.filter.aria}>
            {stage.stage === 'field'
              ? stage.items.map((item, index) => (
                  <li
                    key={`${item.kind}:${item.path}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    className={cn(
                      'flex h-[22px] cursor-pointer items-center gap-2.5 px-2.5',
                      index === highlight && 'bg-[var(--vscode-list-activeSelectionBackground,rgba(55,148,255,0.25))]'
                    )}
                    onClick={() => accept(index)}
                  >
                    <span className="flex-1 truncate font-mono text-xs">{item.path}</span>
                    {item.kind === 'server' ? (
                      <span className="rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                        {stored ? t.filter.storedBadge : t.filter.serverBadge}
                      </span>
                    ) : (
                      <>
                        <span
                          className={cn(
                            'rounded bg-muted px-1.5 font-mono text-[10px]',
                            item.type && TYPE_TONE[item.type]
                          )}
                        >
                          {item.type ? t.picker[TYPE_LABEL_KEY[item.type]] : ''}
                        </span>
                        <span className="h-[5px] w-9 shrink-0 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                          <i
                            className="block h-full bg-[color:var(--vscode-charts-blue,#4e7fb3)]"
                            style={{ width: `${item.share ?? 0}%` }}
                          />
                        </span>
                        <span className="w-8 text-right text-[11px] text-muted-foreground">{item.share ?? 0}%</span>
                        {item.isColumn ? (
                          <span className="text-[11px] text-muted-foreground">{t.filter.inColumns}</span>
                        ) : null}
                      </>
                    )}
                  </li>
                ))
              : null}
            {stage.stage === 'operator'
              ? stage.items.map((op, index) => (
                  <li
                    key={op}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    className={cn(
                      'flex h-[22px] cursor-pointer items-center px-2.5 font-mono text-xs',
                      index === highlight && 'bg-[var(--vscode-list-activeSelectionBackground,rgba(55,148,255,0.25))]'
                    )}
                    onClick={() => accept(index)}
                  >
                    {op}
                  </li>
                ))
              : null}
            {stage.stage === 'value' ? (
              stage.items.length > 0 ? (
                stage.items.map((item, index) => (
                  <li
                    key={item.value}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    className={cn(
                      'flex h-[22px] cursor-pointer items-center gap-2.5 px-2.5',
                      index === highlight && 'bg-[var(--vscode-list-activeSelectionBackground,rgba(55,148,255,0.25))]'
                    )}
                    onClick={() => accept(index)}
                  >
                    <span className="flex-1 truncate font-mono text-xs text-[color:var(--vscode-debugTokenExpression-string,#ce9178)]">
                      {item.value}
                    </span>
                    {item.count !== undefined ? (
                      <span className="text-[11px] text-muted-foreground">
                        {item.count === 1
                          ? t.filter.rowCountOne
                          : fillTemplate(t.filter.rowsCount, { count: item.count })}
                      </span>
                    ) : null}
                  </li>
                ))
              ) : (
                <li role="presentation" className="px-2.5 py-1 text-xs text-muted-foreground">
                  {t.filter.noSuggestions}
                </li>
              )
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FilterChipView({
  t,
  chip,
  disabled,
  stored,
  onEdit
}: {
  t: CustomLogsMessages;
  chip: FilterChip;
  disabled: boolean;
  stored: boolean;
  onEdit: (text: string) => void;
}) {
  const Icon = chip.scope === 'server' ? Cloud : ListFilter;
  const scopeTitle =
    chip.scope === 'server' ? (stored ? t.filter.storedChip : t.filter.serverChip) : t.filter.loadedChip;
  const editable = chip.onEdit !== undefined && !disabled;
  return (
    <span
      data-testid="filter-chip"
      data-scope={chip.scope}
      title={scopeTitle}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border pl-1.5 pr-1 font-mono text-xs',
        chip.scope === 'server'
          ? 'border-[color:var(--vscode-focusBorder,#007fd4)] bg-[color-mix(in_srgb,var(--vscode-focusBorder,#007fd4)_14%,transparent)]'
          : 'border-border bg-muted'
      )}
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <button
        type="button"
        disabled={!editable}
        className="inline-flex items-center gap-1 enabled:cursor-pointer enabled:hover:underline"
        aria-label={fillTemplate(t.filter.editChip, { filter: chip.text })}
        onClick={() => {
          if (chip.onEdit) {
            onEdit(chip.onEdit());
          }
        }}
      >
        <span className="text-[color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe)]">{chip.field}</span>
        <span className="text-[color:var(--vscode-symbolIcon-keywordForeground,#c586c0)]">{chip.op}</span>
        {chip.value !== undefined ? (
          <span className="text-[color:var(--vscode-debugTokenExpression-string,#ce9178)]">{chip.value}</span>
        ) : null}
      </button>
      {chip.onRemove ? (
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/15 hover:text-foreground"
          aria-label={fillTemplate(t.filter.removeChip, { filter: chip.text })}
          onClick={chip.onRemove}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
