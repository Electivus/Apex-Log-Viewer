import React, { useLayoutEffect, useRef } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { LogCategory, ParsedLogEntry } from '../../utils/logViewerParser';
import { Bug, Database, Edit3, Settings, Info, AlertTriangle, Cpu } from 'lucide-react';

interface Props {
  entry: ParsedLogEntry;
  highlighted: boolean;
  onMeasured: (height: number) => void;
}

export function LogEntryRow({ entry, highlighted, onMeasured }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => onMeasured(Math.ceil(el.scrollHeight) + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogEntryRow: failed to disconnect ResizeObserver', e);
      }
    };
  }, [entry, onMeasured]);

  const { badgeClass, icon: Icon, iconClass } = getCategoryVisuals(entry.category);

  return (
    <div
      ref={ref}
      className={cn(
        'flex items-start gap-3 border-b border-border/40 px-4 py-2 text-xs transition-colors',
        highlighted ? 'bg-sky-500/10' : 'hover:bg-muted/20'
      )}
    >
      <div className="mt-0.5 min-w-[84px] font-mono text-[11px] text-muted-foreground">
        {entry.timestamp || '—'}
      </div>
      <div className="flex min-w-[140px] items-center gap-2">
        <Icon className={cn('h-3.5 w-3.5', iconClass)} />
        <Badge className={cn('border px-2 py-0.5 text-[11px] uppercase tracking-wide', badgeClass)}>
          {entry.type}
        </Badge>
      </div>
      <div className="min-w-[50px] font-mono text-[11px] text-muted-foreground">
        {entry.lineNumber ? `[${entry.lineNumber}]` : ''}
      </div>
      <div className="flex-1 space-y-1 text-[12px] leading-relaxed text-foreground">
        <div className="break-words text-sm">{entry.message || entry.raw}</div>
        {entry.details && (
          <div className="rounded-md bg-muted/15 px-3 py-1 font-mono text-[11px] text-muted-foreground shadow-inner">
            {entry.details}
          </div>
        )}
      </div>
    </div>
  );
}

function getCategoryVisuals(category: LogCategory) {
  switch (category) {
    case 'debug':
      return { badgeClass: 'border-sky-500/40 bg-sky-500/15 text-sky-200', icon: Bug, iconClass: 'text-sky-400' };
    case 'soql':
      return {
        badgeClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
        icon: Database,
        iconClass: 'text-emerald-400'
      };
    case 'dml':
      return {
        badgeClass: 'border-orange-500/40 bg-orange-500/15 text-orange-200',
        icon: Edit3,
        iconClass: 'text-orange-400'
      };
    case 'code':
      return {
        badgeClass: 'border-purple-500/40 bg-purple-500/15 text-purple-200',
        icon: Settings,
        iconClass: 'text-purple-400'
      };
    case 'limit':
      return {
        badgeClass: 'border-yellow-500/40 bg-yellow-500/15 text-yellow-200',
        icon: AlertTriangle,
        iconClass: 'text-yellow-400'
      };
    case 'system':
      return {
        badgeClass: 'border-slate-500/40 bg-slate-500/15 text-slate-200',
        icon: Cpu,
        iconClass: 'text-slate-300'
      };
    default:
      return {
        badgeClass: 'border-border/60 bg-muted/10 text-muted-foreground',
        icon: Info,
        iconClass: 'text-muted-foreground'
      };
  }
}
