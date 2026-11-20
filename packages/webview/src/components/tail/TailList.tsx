import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { decodeLogLine } from '@alv/protocol/logText';
import type { Messages } from '../../i18n';
import { List, type DynamicRowHeight, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import { apexLineStyle, categoryStyle, contentHighlightRules, highlightContent, parseApexLine } from '../../utils/tail';

type TailListProps = {
  lines: string[];
  filteredIndexes: number[];
  /** Sequence number of `lines[0]`: how many lines left the buffer before it since the panel opened. */
  firstLineSeq: number;
  selectedIndex?: number;
  onSelectIndex: (idx: number) => void;
  colorize: boolean;
  running: boolean;
  listRef: React.RefObject<ListImperativeAPI | null>;
  /** Keep the newest line in view while true (Auto-scroll). */
  follow: boolean;
  t: Messages;
  onAtBottomChange?: (atBottom: boolean) => void;
  virtualListComponent?: typeof List;
};

/** The list token is unset in High Contrast, where the editor selection is solid white; the row keeps its outline there. */
const SELECTED_ROW_BACKGROUND = 'var(--vscode-list-activeSelectionBackground, transparent)';

/** Distance from the end, in px, that still counts as being at the bottom. */
const AT_BOTTOM_THRESHOLD = 4;

/** Height a row counts until it is measured, close to one line at the default font. */
const DEFAULT_ROW_HEIGHT = 18;

const sepStyle: React.CSSProperties = { opacity: 0.4 };
const timeStyle: React.CSSProperties = { opacity: 0.6 };
const debugMsgStyle: React.CSSProperties = { color: 'var(--vscode-charts-blue)' };

type TailRowProps = {
  lines: readonly string[];
  filteredIndexes: readonly number[];
  firstLineSeq: number;
  selectedIndex: number | undefined;
  onSelectIndex: (idx: number) => void;
  colorize: boolean;
  t: Messages;
};

type LineSeqSource = Pick<TailRowProps, 'filteredIndexes' | 'firstLineSeq'>;

/** A line keeps its sequence number while older lines leave the buffer, so it keys the row and its height. */
const lineSeqAt = (index: number, { filteredIndexes, firstLineSeq }: LineSeqSource) => {
  const fullIdx = filteredIndexes[index];
  return fullIdx === undefined ? undefined : firstLineSeq + fullIdx;
};

const tailRowKey = (index: number, rowProps: TailRowProps) => lineSeqAt(index, rowProps) ?? `index-${index}`;

/**
 * Row heights in react-window's dynamic row height protocol, kept per line sequence number, so a line keeps its
 * height when older lines leave the buffer or a filter moves it. The List measures every row it renders through
 * `observeRowElements`. The map is mutable so that a measurement does not copy a map that can hold a height for
 * each of the buffer's lines, up to 200,000.
 */
function useLineRowHeights(filteredIndexes: readonly number[], firstLineSeq: number): DynamicRowHeight {
  const heightsRef = useRef(new Map<number, number>());
  const [version, setVersion] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const record = useCallback((measured: ReadonlyArray<readonly [number, number]>) => {
    const heights = heightsRef.current;
    let changed = false;
    for (const [seq, size] of measured) {
      if (heights.get(seq) !== size) {
        heights.set(seq, size);
        changed = true;
      }
    }
    if (changed) {
      setVersion(v => v + 1);
    }
  }, []);

  const observeRowElements = useCallback(
    (elements: Element[] | NodeListOf<Element>) => {
      observerRef.current ??= new ResizeObserver(entries =>
        record(
          entries.flatMap(({ target, borderBoxSize }) => {
            const seq = Number(target.getAttribute('data-line-seq') ?? Number.NaN);
            const size = borderBoxSize[0]?.blockSize ?? 0;
            return Number.isInteger(seq) && size > 0 ? [[seq, Math.ceil(size)] as const] : [];
          })
        )
      );
      const observer = observerRef.current;
      const rows = Array.from(elements);
      rows.forEach(row => observer.observe(row));
      return () => rows.forEach(row => observer.unobserve(row));
    },
    [record]
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Lines before the first one left the buffer for good. A small trim deletes their keys one by one; a trim
  // larger than the map walks the map instead.
  const prunedBelowRef = useRef(firstLineSeq);
  useEffect(() => {
    const heights = heightsRef.current;
    const from = prunedBelowRef.current;
    prunedBelowRef.current = firstLineSeq;
    if (firstLineSeq - from <= heights.size) {
      for (let seq = from; seq < firstLineSeq; seq++) {
        heights.delete(seq);
      }
      return;
    }
    for (const seq of heights.keys()) {
      if (seq < firstLineSeq) {
        heights.delete(seq);
      }
    }
  }, [firstLineSeq]);

  // A new object for each `version` tells the List that the mutable height map changed.
  return useMemo<DynamicRowHeight>(() => {
    const source = { filteredIndexes, firstLineSeq };
    return {
      getAverageRowHeight: () => DEFAULT_ROW_HEIGHT,
      getRowHeight: index => {
        const seq = lineSeqAt(index, source);
        return seq === undefined ? undefined : heightsRef.current.get(seq);
      },
      setRowHeight: (index, size) => {
        const seq = lineSeqAt(index, source);
        if (seq !== undefined) {
          record([[seq, size]]);
        }
      },
      observeRowElements
    };
  }, [filteredIndexes, firstLineSeq, version, observeRowElements, record]);
}

function TailRow({ index, style, ...rowProps }: RowComponentProps<TailRowProps>) {
  const { lines, filteredIndexes, selectedIndex, onSelectIndex, colorize, t } = rowProps;
  const fullIdx = filteredIndexes[index];
  const text = fullIdx === undefined ? undefined : lines[fullIdx];
  if (fullIdx === undefined || text === undefined) {
    return null;
  }
  return (
    <div
      role="row"
      style={style}
      data-line-seq={lineSeqAt(index, rowProps)}
      className="cursor-pointer overflow-hidden border-b border-border/60 transition-colors hover:bg-muted/25"
      onClick={() => onSelectIndex(fullIdx)}
    >
      <RowContent text={text} colorize={colorize} selected={selectedIndex === fullIdx} t={t} />
    </div>
  );
}

export function TailList({
  lines,
  filteredIndexes,
  firstLineSeq,
  selectedIndex,
  onSelectIndex,
  colorize,
  running,
  listRef,
  follow,
  t,
  onAtBottomChange,
  virtualListComponent
}: TailListProps) {
  const [height, setHeight] = useState(0);
  const outerRef = useRef<HTMLDivElement | null>(null);
  // react-window publishes its imperative handle before its scroll element exists, so
  // `listRef.current.element` is still null after the first commit. Keep the element in
  // state so the effects below run again once it is there.
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const setVirtualListRef = useCallback(
    (api: ListImperativeAPI | null) => {
      listRef.current = api;
      setListElement(api?.element ?? null);
    },
    [listRef]
  );
  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);
  const atBottomRef = useRef<boolean | null>(null);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  // Follow state: `followRef` mirrors the prop for callbacks, `stuckRef` says the view is
  // pinned to the end, and `lastTopRef` is the scroll offset we last saw or set, so a
  // user scroll that has not dispatched its scroll event yet is not undone.
  const followRef = useRef(follow);
  const stuckRef = useRef(false);
  const lastTopRef = useRef(0);
  const prevFollowRef = useRef(false);
  const prevListElementRef = useRef<HTMLDivElement | null>(null);
  const VirtualList = virtualListComponent ?? List;

  const rowProps = useMemo<TailRowProps>(
    () => ({ lines, filteredIndexes, firstLineSeq, selectedIndex, onSelectIndex, colorize, t }),
    [lines, filteredIndexes, firstLineSeq, selectedIndex, onSelectIndex, colorize, t]
  );
  const rowHeight = useLineRowHeights(filteredIndexes, firstLineSeq);

  // The list takes the height the panel leaves under the toolbar. When a short, narrow panel cannot fit a wrapped
  // toolbar, the root scrolls instead and the list keeps its minimum height, so no control or row is clipped.
  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const recompute = () => setHeight(Math.max(0, Math.floor(outer.clientHeight)));
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(outer);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('TailList: failed to disconnect ResizeObserver', e);
      }
    };
  }, []);

  // Pin the view to the end while following. The list's total height is an estimate that
  // grows as rows are rendered and measured, so this runs again after each such change
  // instead of trusting a single scrollToRow call.
  const pinToEnd = useCallback(
    (force: boolean) => {
      const el = listElement;
      if (!el || !followRef.current) return;
      if (!force) {
        if (!stuckRef.current) return;
        const top = el.scrollTop;
        const gap = el.scrollHeight - el.clientHeight - top;
        // The user moved up and the scroll listener has not seen it yet: leave it to pause.
        if (top < lastTopRef.current - 1 && gap > AT_BOTTOM_THRESHOLD) return;
      }
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (el.scrollTop !== target) el.scrollTop = target;
      lastTopRef.current = el.scrollTop;
      stuckRef.current = true;
      atBottomRef.current = true;
    },
    [listElement]
  );

  useLayoutEffect(() => {
    onAtBottomChangeRef.current = onAtBottomChange;
    followRef.current = follow;
    const started = follow && (!prevFollowRef.current || prevListElementRef.current !== listElement);
    prevFollowRef.current = follow;
    prevListElementRef.current = listElement;
    if (started) {
      // With dynamic row heights, scrollToRow keeps steering toward the row it revealed, such as
      // the selected line, until the rows settle. The List stops that on the keys a user scrolls
      // with, so End hands the scroll back to this pin before it can pull the view up again.
      listElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    }
    pinToEnd(started);
  });

  // The list renders more rows (and refines its height estimate) after each scroll.
  const onRowsRendered = useCallback(() => pinToEnd(false), [pinToEnd]);

  // Empty state when nothing matches
  const showEmpty = filteredIndexes.length === 0;

  // Detect whether the list is scrolled to the bottom and notify parent on changes. This
  // runs in the scroll event itself so a scroll up stops the pinning before the next render.
  React.useEffect(() => {
    const el = listElement;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      const atBottom = el.scrollHeight - (top + el.clientHeight) <= AT_BOTTOM_THRESHOLD;
      stuckRef.current = atBottom;
      lastTopRef.current = top;
      if (atBottomRef.current !== atBottom) {
        atBottomRef.current = atBottom;
        onAtBottomChangeRef.current?.(atBottom);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [listElement]);

  // Adaptive overscan based on scroll velocity
  React.useEffect(() => {
    const el = listElement;
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
  }, [listElement]);

  return (
    <div ref={outerRef} className="relative min-h-[120px] flex-1 overflow-hidden font-mono text-xs text-foreground">
      {showEmpty ? (
        <p className="px-3 py-2 font-sans text-sm text-muted-foreground">
          {running ? (t.tail?.waiting ?? 'Waiting for logs…') : (t.tail?.pressStart ?? 'Press Start to tail logs.')}
        </p>
      ) : (
        <VirtualList
          listRef={setVirtualListRef}
          style={{ height, width: '100%' }}
          rowCount={filteredIndexes.length}
          rowHeight={rowHeight}
          rowKey={tailRowKey}
          overscanCount={overscanCount}
          rowProps={rowProps}
          onRowsRendered={onRowsRendered}
          rowComponent={TailRow}
        />
      )}
    </div>
  );
}

function RowContent({
  text,
  colorize,
  selected,
  t
}: {
  text: string;
  colorize: boolean;
  selected: boolean;
  t: Messages;
}) {
  const commonStyle: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    // Break a line with no spaces, such as the log's category header, instead of clipping it at the
    // row's edge. The ResizeObserver above measures the taller row.
    overflowWrap: 'anywhere',
    background: selected ? SELECTED_ROW_BACKGROUND : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground, inherit)' : undefined,
    outline: selected ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
    borderLeft: selected ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
    cursor: 'pointer'
  };

  // Token colors are chosen for the editor background, so a selected row drops them for the selection foreground.
  if (!colorize || selected) {
    return (
      <div style={commonStyle} className="px-3 py-1.5 text-xs leading-relaxed">
        {decodeLogLine(text)}
      </div>
    );
  }

  const parsed = parseApexLine(text);
  const cat = parsed.category;
  const catSty = categoryStyle(cat, text);
  const lineFallback = apexLineStyle(text, colorize);

  if (!parsed.time && !cat) {
    const segs = highlightContent(decodeLogLine(text), contentHighlightRules);
    return (
      <div
        style={{
          ...commonStyle,
          ...lineFallback,
          background: lineFallback.background || 'transparent'
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
    <div style={commonStyle} className="px-3 py-1.5 text-xs leading-relaxed">
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
