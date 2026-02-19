import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Messages } from '../../i18n';
import { List, type ListImperativeAPI } from 'react-window';
import { cn } from '../../lib/utils';
import { apexLineStyle, categoryStyle, contentHighlightRules, highlightContent, parseApexLine } from '../../utils/tail';

type TailListProps = {
  lines: string[];
  filteredIndexes: number[];
  selectedIndex?: number;
  onSelectIndex: (idx: number) => void;
  colorize: boolean;
  running: boolean;
  listRef: React.RefObject<ListImperativeAPI | null>;
  t: Messages;
  onAtBottomChange?: (atBottom: boolean) => void;
  virtualListComponent?: typeof List;
};

export function TailList({
  lines,
  filteredIndexes,
  selectedIndex,
  onSelectIndex,
  colorize,
  running,
  listRef,
  t,
  onAtBottomChange,
  virtualListComponent
}: TailListProps) {
  const defaultRowHeight = 18; // close to single-line height at default font
  const rowHeightsRef = useRef<Record<number, number>>({});
  const [height, setHeight] = useState(420);
  const outerRef = useRef<HTMLDivElement | null>(null);
  // Removed outerRef for List v2; use listRef.current.element instead
  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);
  const atBottomRef = useRef<boolean | null>(null);
  const VirtualList = virtualListComponent ?? List;

  const getItemSize = (index: number) => rowHeightsRef.current[index] ?? defaultRowHeight;
  // Batch re-render to reflect updated row heights
  const rafRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);
  const scheduleRerender = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      forceRender(v => v + 1);
    });
  };
  const setRowHeight = (index: number, size: number) => {
    const next = Math.max(defaultRowHeight, Math.ceil(size));
    if (rowHeightsRef.current[index] !== next) {
      rowHeightsRef.current[index] = next;
      scheduleRerender();
    }
  };

  // Auto-size list to fit viewport similarly to LogsTable
  useLayoutEffect(() => {
    const recompute = () => {
      const rect = outerRef.current?.getBoundingClientRect();
      const top = rect?.top ?? 0;
      const available = Math.max(160, Math.floor(window.innerHeight - top - 12));
      setHeight(available);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (outerRef.current) ro.observe(outerRef.current);
    window.addEventListener('resize', recompute);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('TailList: failed to disconnect ResizeObserver', e);
      }
      window.removeEventListener('resize', recompute);
    };
  }, []);

  const itemKey = (index: number) => filteredIndexes[index] ?? index;

  const sepStyle: React.CSSProperties = { opacity: 0.4 };
  const timeStyle: React.CSSProperties = { opacity: 0.6 };
  const debugMsgStyle: React.CSSProperties = { color: 'var(--vscode-charts-blue)' };

  const renderRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const fullIdx = filteredIndexes[index]!;
    const l = lines[fullIdx]!;
    return (
      <div
        role="row"
        style={style}
        className="cursor-pointer overflow-hidden border-b border-border/60 transition-colors hover:bg-muted/25"
        onClick={() => onSelectIndex(fullIdx)}
      >
        <RowContent
          text={l}
          colorize={colorize}
          selected={selectedIndex === fullIdx}
          sepStyle={sepStyle}
          timeStyle={timeStyle}
          debugMsgStyle={debugMsgStyle}
          t={t}
          onMeasured={h => setRowHeight(index, h)}
        />
      </div>
    );
  };

  const onRowsRendered = (_: { startIndex: number; stopIndex: number }) => {
    // Reserved for future tail auto-paging; no-op today
  };

  // Empty state when nothing matches
  const showEmpty = filteredIndexes.length === 0;

  // Detect whether the list is scrolled to the bottom and notify parent on changes
  React.useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const threshold = 4; // px
    const compute = () => {
      const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= threshold;
      if (atBottomRef.current !== atBottom) {
        atBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
      }
    };
    compute();
    const onScroll = () => {
      // throttle to next frame
      requestAnimationFrame(compute);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onAtBottomChange, height, filteredIndexes.length]);

  // Adaptive overscan based on scroll velocity
  React.useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const onScroll = () => {
      const now = performance.now();
      const dt = now - (overscanLastTsRef.current || now);
      const dy = Math.abs(el.scrollTop - (overscanLastTopRef.current || 0));
      if (dt > 16) {
        const v = dy / dt; // px per ms
        let next = overscanBaseRef.current;
        if (v > 2) next = 22;
        else if (v > 1) next = 14;
        else if (v > 0.4) next = 10;
        else next = overscanBaseRef.current; // idle/slow
        if (next !== overscanLastSetRef.current) {
          overscanLastSetRef.current = next;
          setOverscanCount(next);
        }
        if (overscanDecayRef.current) clearTimeout(overscanDecayRef.current);
        overscanDecayRef.current = setTimeout(() => {
          if (overscanLastSetRef.current !== overscanBaseRef.current) {
            overscanLastSetRef.current = overscanBaseRef.current;
            setOverscanCount(overscanBaseRef.current);
          }
        }, 200);
      }
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div ref={outerRef} className="flex-1">
      <div
        className="relative w-full overflow-hidden rounded-lg border border-border bg-background/40 font-mono text-xs text-foreground shadow-inner"
        style={{ height }}
      >
        {showEmpty ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {running ? (t.tail?.waiting ?? 'Waiting for logs…') : (t.tail?.pressStart ?? 'Press Start to tail logs.')}
          </div>
        ) : (
          <VirtualList
            listRef={listRef}
            style={{ height, width: '100%' }}
            rowCount={filteredIndexes.length}
            rowHeight={(index: number) => getItemSize(index)}
            overscanCount={overscanCount}
            rowProps={{}}
            onRowsRendered={onRowsRendered}
            rowComponent={(props: { index: number; style: React.CSSProperties }) => renderRow(props)}
          />
        )}
      </div>
    </div>
  );
}

function RowContent({
  text,
  colorize,
  selected,
  sepStyle,
  timeStyle,
  debugMsgStyle,
  t,
  onMeasured
}: {
  text: string;
  colorize: boolean;
  selected: boolean;
  sepStyle: React.CSSProperties;
  timeStyle: React.CSSProperties;
  debugMsgStyle: React.CSSProperties;
  t: Messages;
  onMeasured: (h: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => onMeasured((el.scrollHeight || el.getBoundingClientRect().height) + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('TailList(RowContent): failed to disconnect ResizeObserver', e);
      }
    };
  }, [text, onMeasured, colorize, selected]);

  const commonStyle: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    background: selected ? 'var(--vscode-editor-selectionBackground)' : 'transparent',
    outline: selected ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
    borderLeft: selected ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
    cursor: 'pointer'
  };

  if (!colorize) {
    return (
      <div ref={ref} style={commonStyle} className="px-3 py-1.5 text-xs leading-relaxed">
        {text}
      </div>
    );
  }

  const parsed = parseApexLine(text);
  const cat = parsed.category;
  const catSty = categoryStyle(cat, text);
  const lineFallback = apexLineStyle(text, colorize);

  if (!parsed.time && !cat) {
    const segs = highlightContent(text, contentHighlightRules);
    return (
      <div
        ref={ref}
        style={{
          ...commonStyle,
          ...lineFallback,
          background: selected ? 'var(--vscode-editor-selectionBackground)' : lineFallback.background || 'transparent'
        }}
        className="px-3 py-1.5 text-xs leading-relaxed"
      >
        {segs.map((s, j) => (
          <span key={j} style={s.style}>
            {s.text}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div ref={ref} style={commonStyle} className="px-3 py-1.5 text-xs leading-relaxed">
      {parsed.time && (
        <>
          <span style={timeStyle}>{parsed.time}</span>
          {parsed.nanos && (
            <>
              <span style={timeStyle}> ({parsed.nanos})</span>
            </>
          )}
          <span style={sepStyle}> | </span>
        </>
      )}
      {cat && (
        <>
          <span style={catSty}>{cat}</span>
          {parsed.tokens.length > 0 && <span style={sepStyle}> | </span>}
        </>
      )}
      {cat && cat.toUpperCase().includes('USER_DEBUG') && parsed.debugMessage ? (
        <>
          <span style={{ opacity: 0.6 }}>[{t.tail?.debugTag ?? 'debug'}]</span>
          <span style={sepStyle}> | </span>
          {highlightContent(parsed.debugMessage, contentHighlightRules).map((s, j) => (
            <span key={j} style={s.style ?? debugMsgStyle}>
              {s.text}
            </span>
          ))}
        </>
      ) : (
        highlightContent(parsed.tokens.join('|'), contentHighlightRules).map((s, j) => (
          <span key={j} style={s.style}>
            {s.text}
          </span>
        ))
      )}
    </div>
  );
}
