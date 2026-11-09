import React, { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Input } from '../ui/input';

type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel: string;
  className?: string;
};

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
  );
}

/** The one search of a Custom Logs webview. `/` focuses it unless the user is typing in another control. */
export function SearchInput({ value, onChange, label, placeholder, clearLabel, className }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        className="pl-7 pr-7 [&::-webkit-search-cancel-button]:hidden"
        onChange={event => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute right-1.5 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-foreground/15 hover:text-foreground"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
