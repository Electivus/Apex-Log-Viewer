import React from 'react';
import { Button } from '../ui/button';
import { logViewerEn, type LogViewerMessages } from '../../i18n/logViewer';
import { fillTemplate } from '../../utils/customLogs/format';
import type { LogCategory } from '../../utils/logViewerParser';
import { CATEGORY_VISUALS } from './logVisuals';

export type LogFilter = 'all' | 'debug' | 'error' | 'soql' | 'dml';
type ChipFilter = Exclude<LogFilter, 'all'>;

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
  t?: LogViewerMessages;
}

type LogCounts = Props['counts'];

const CHIPS: ReadonlyArray<{
  filter: ChipFilter;
  category: LogCategory;
  label: (t: LogViewerMessages) => string;
  count: (counts: LogCounts) => number;
}> = [
  { filter: 'debug', category: 'debug', label: t => t.debugOnly, count: counts => counts.debug },
  { filter: 'error', category: 'error', label: t => t.errors, count: counts => counts.errors },
  { filter: 'soql', category: 'soql', label: () => 'SOQL', count: counts => counts.soql },
  { filter: 'dml', category: 'dml', label: () => 'DML', count: counts => counts.dml }
];

function formatCount(n: number, locale: string) {
  try {
    return n.toLocaleString(locale || undefined);
  } catch {
    return n.toLocaleString();
  }
}

export function LogViewerFilters({ active, onChange, counts, locale, t = logViewerEn }: Props) {
  const showing = CHIPS.find(chip => chip.filter === active)?.count(counts) ?? counts.total;

  return (
    <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
      <span className="text-muted-foreground">{t.filters}</span>
      <div role="group" aria-label={t.filters} className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map(chip => {
          const pressed = active === chip.filter;
          const count = chip.count(counts);
          const { icon: Icon } = CATEGORY_VISUALS[chip.category];
          return (
            <Button
              key={chip.filter}
              type="button"
              size="sm"
              variant={pressed ? 'default' : 'outline'}
              aria-pressed={pressed}
              className="log-toggle"
              disabled={count === 0 && !pressed}
              onClick={() => onChange(pressed ? 'all' : chip.filter)}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{chip.label(t)}</span>
              <span className="font-normal tabular-nums">{formatCount(count, locale)}</span>
            </Button>
          );
        })}
      </div>
      <span className="flex-1" />
      <span className="text-muted-foreground">{t.showing}</span>
      <span className="tabular-nums text-foreground">
        {fillTemplate(showing === 1 ? t.entriesOne : t.entriesOther, { count: formatCount(showing, locale) })}
      </span>
    </section>
  );
}
