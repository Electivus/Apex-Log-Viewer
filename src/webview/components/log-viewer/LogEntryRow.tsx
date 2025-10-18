import React, { useLayoutEffect, useRef } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { LogCategory, ParsedLogEntry } from '../../utils/logViewerParser';
import { Bug, Database, Edit3, Settings, Info, AlertTriangle, AlertOctagon, Cpu } from 'lucide-react';

interface Props {
  entry: ParsedLogEntry;
  highlighted: boolean;
  isMatch?: boolean;
  isActiveMatch?: boolean;
  searchTerm?: string;
  onMeasured: (height: number) => void;
}

export function LogEntryRow({ entry, highlighted, isMatch, isActiveMatch, searchTerm, onMeasured }: Props) {
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
  const normalizedTerm = (searchTerm ?? '').trim();
  const showMatchHighlight = normalizedTerm.length > 0 && isMatch;

  return (
    <div
      ref={ref}
      className={cn(
        'flex items-start gap-3 border-b border-border/40 px-4 py-2 text-xs transition-colors',
        !(highlighted || showMatchHighlight || isActiveMatch) && 'hover:bg-muted/20',
        highlighted && 'bg-sky-500/10',
        showMatchHighlight && 'bg-amber-500/10',
        isActiveMatch && 'bg-amber-500/20 ring-1 ring-amber-400'
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
        <div className="break-words text-sm">{highlightText(entry.message || entry.raw, normalizedTerm)}</div>
        {entry.details && (
          <div className="rounded-md bg-muted/15 px-3 py-1 font-mono text-[11px] text-muted-foreground shadow-inner">
            {highlightText(entry.details, normalizedTerm)}
          </div>
        )}
      </div>
    </div>
  );
}

function highlightText(text: string | undefined, term: string) {
  if (!text) {
    return null;
  }
  const trimmed = term.trim();
  if (!trimmed) {
    return text;
  }
  const lower = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  if (!lower.includes(needle)) {
    return text;
  }
  const parts: React.ReactNode[] = [];
  let index = 0;
  let matchIndex = lower.indexOf(needle, index);
  let key = 0;
  while (matchIndex !== -1) {
    if (matchIndex > index) {
      parts.push(text.slice(index, matchIndex));
    }
    const matchText = text.slice(matchIndex, matchIndex + trimmed.length);
    parts.push(
      <mark key={`match-${key++}`} className="rounded-sm bg-amber-500/40 px-[1px] text-foreground">
        {matchText}
      </mark>
    );
    index = matchIndex + trimmed.length;
    matchIndex = lower.indexOf(needle, index);
  }
  if (index < text.length) {
    parts.push(text.slice(index));
  }
  return <>{parts}</>;
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
    case 'error':
      return {
        badgeClass: 'border-red-500/40 bg-red-500/15 text-red-200',
        icon: AlertOctagon,
        iconClass: 'text-red-400'
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
