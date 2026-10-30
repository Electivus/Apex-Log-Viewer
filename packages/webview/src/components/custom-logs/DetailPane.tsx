import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

type DetailPaneProps = {
  ariaLabel: string;
  testId: string;
  dock: 'right' | 'bottom';
  /** Tailwind size classes for each dock. */
  size: { right: string; bottom: string };
  header: React.ReactNode;
  children: React.ReactNode;
};

/** The shell of the row and entry detail: a header row over a scrolling body, docked right or bottom. */
export function DetailPane({ ariaLabel, testId, dock, size, header, children }: DetailPaneProps) {
  return (
    <aside
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'flex min-h-0 min-w-0 shrink-0 flex-col bg-card/60',
        dock === 'right' ? `${size.right} border-l border-border` : `${size.bottom} border-t border-border`
      )}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">{header}</header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-2">{children}</div>
    </aside>
  );
}

export function DetailCloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="h-6 min-h-0 w-6" aria-label={label} onClick={onClick}>
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  );
}

export function Facts({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">{children}</div>;
}

export function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <span className="min-w-0 truncate" title={value}>
      <span className="text-muted-foreground">{label} </span>
      <span className="font-mono">{value}</span>
    </span>
  );
}
