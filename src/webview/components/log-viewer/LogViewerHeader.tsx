import React from 'react';
import { FileText, Search } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';

interface Props {
  fileName: string;
  search: string;
  onSearchChange: (value: string) => void;
  onViewRaw: () => void;
  disabled?: boolean;
}

export function LogViewerHeader({ fileName, search, onSearchChange, onViewRaw, disabled }: Props) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border/60 bg-card/40 px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileText className="h-5 w-5 text-sky-400" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">Apex Log Viewer</div>
          <div className="truncate text-xs text-muted-foreground">{fileName || 'Debug Log Analysis'}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Search entries…"
            className={cn('w-64 pl-8 text-sm', disabled && 'opacity-70')}
            disabled={disabled}
          />
        </div>
        <Button variant="outline" size="sm" onClick={onViewRaw} disabled={disabled} className="text-sm">
          <FileText className="mr-2 h-4 w-4" />
          View Raw
        </Button>
      </div>
    </header>
  );
}
