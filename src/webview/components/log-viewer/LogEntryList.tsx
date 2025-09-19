import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import type { ParsedLogEntry, LogCategory } from '../../utils/logViewerParser';
import { LogEntryRow } from './LogEntryRow';

interface Props {
  entries: ParsedLogEntry[];
  highlightCategory?: LogCategory;
}

export function LogEntryList({ entries, highlightCategory }: Props) {
  const defaultRowHeight = 64;
  const rowHeightsRef = useRef<Record<number, number>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<ListImperativeAPI | null>(null);
  const [height, setHeight] = useState<number>(420);
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);

  const scheduleRerender = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender(v => v + 1);
    });
  }, []);

  const setRowHeight = useCallback(
    (index: number, size: number) => {
      const next = Math.max(defaultRowHeight, Math.ceil(size));
      if (rowHeightsRef.current[index] !== next) {
        rowHeightsRef.current[index] = next;
        scheduleRerender();
      }
    },
    [defaultRowHeight, scheduleRerender]
  );

  const getItemSize = useCallback((index: number) => rowHeightsRef.current[index] ?? defaultRowHeight, [defaultRowHeight]);

  useLayoutEffect(() => {
    const recompute = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const top = rect?.top ?? 0;
      const available = Math.max(180, Math.floor(window.innerHeight - top - 16));
      setHeight(available);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogEntryList: failed to disconnect ResizeObserver', e);
      }
    };
  }, []);

  const data = useMemo(() => ({ entries, highlightCategory, setRowHeight }), [entries, highlightCategory, setRowHeight]);

  const renderRow = useCallback(
    ({ index, style, entries: listEntries, highlightCategory: target, setRowHeight: measure }: any) => {
      const entry = listEntries[index] as ParsedLogEntry | undefined;
      if (!entry) return null;
      const highlighted = target ? entry.category === target : false;
      return (
        <div style={style}>
          <LogEntryRow entry={entry} highlighted={highlighted} onMeasured={h => measure(index, h)} />
        </div>
      );
    },
    []
  );

  return (
    <div ref={containerRef} className="flex-1">
      <div className="h-full overflow-hidden rounded-lg border border-border/60 bg-background/60 shadow-inner">
        {entries.length === 0 ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">No entries match the current filters.</div>
        ) : (
          <List
            listRef={listRef}
            style={{ height, width: '100%' }}
            rowCount={entries.length}
            rowHeight={(index: number) => getItemSize(index)}
            overscanCount={12}
            rowProps={data}
            rowComponent={(props: { index: number; style: React.CSSProperties }) =>
              renderRow({ ...props, ...data })
            }
          />
        )}
      </div>
    </div>
  );
}
