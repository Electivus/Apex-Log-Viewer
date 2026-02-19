import React from 'react';
import { AlertOctagon, Bug, Database, Edit3, Filter, Eye } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';

export type LogFilter = 'all' | 'debug' | 'error' | 'soql' | 'dml';

interface Props {
  active: LogFilter;
  onChange: (next: LogFilter) => void;
  counts: {
    total: number;
    debug: number;
    errors: number;
    soql: number;
    dml: number;
  };
  locale: string;
}

function formatCount(n: number, locale: string) {
  try {
    return n.toLocaleString(locale || undefined);
  } catch {
    return n.toLocaleString();
  }
}

export function LogViewerFilters({ active, onChange, counts, locale }: Props) {
  const showing =
    active === 'debug'
      ? counts.debug
      : active === 'error'
        ? counts.errors
        : active === 'soql'
          ? counts.soql
          : active === 'dml'
            ? counts.dml
            : counts.total;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-background/40 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Filter className="h-4 w-4" />
          <span>Filters:</span>
        </div>
        <Button
          size="sm"
          variant={active === 'debug' ? 'default' : 'outline'}
          onClick={() => onChange(active === 'debug' ? 'all' : 'debug')}
          className={cn(
            'flex items-center gap-2',
            active === 'debug' ? 'bg-sky-600 text-white hover:bg-sky-700' : 'bg-transparent'
          )}
        >
          <Bug className="h-3.5 w-3.5" />
          Debug Only
        </Button>
        <Button
          size="sm"
          variant={active === 'error' ? 'default' : 'ghost'}
          onClick={() => onChange(active === 'error' ? 'all' : 'error')}
          className={cn(
            'flex items-center gap-2',
            active === 'error'
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <AlertOctagon className="h-3.5 w-3.5" />
          Errors
        </Button>
        <Button
          size="sm"
          variant={active === 'soql' ? 'default' : 'ghost'}
          onClick={() => onChange(active === 'soql' ? 'all' : 'soql')}
          className={cn(
            'flex items-center gap-2',
            active === 'soql'
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Database className="h-3.5 w-3.5" />
          SOQL
        </Button>
        <Button
          size="sm"
          variant={active === 'dml' ? 'default' : 'ghost'}
          onClick={() => onChange(active === 'dml' ? 'all' : 'dml')}
          className={cn(
            'flex items-center gap-2',
            active === 'dml'
              ? 'bg-orange-600 text-white hover:bg-orange-700'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Edit3 className="h-3.5 w-3.5" />
          DML
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Eye className="h-4 w-4" />
        <span>Showing:</span>
        <Badge variant="secondary" className="bg-muted/50 text-foreground">
          {formatCount(showing, locale)} entries
        </Badge>
      </div>
    </div>
  );
}
