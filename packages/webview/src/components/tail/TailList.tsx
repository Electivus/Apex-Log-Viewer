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
 * Measured row heights by line sequence number. It also counts the lines at each height, so that a line not measured
 * yet can count the most common height: most log lines fit on one row, so a new line usually measures what it was
 * counted at, and its measurement moves no row.
 */
class LineHeights {
  private readonly bySeq = new Map<number, number>();
  private readonly linesByHeight = new Map<number, number>();
  /** The most common height, or undefined until it is worked out again. */
  private common: number | undefined;

  constructor(private firstSeq: number) {}

  get(seq: number) {
    return this.bySeq.get(seq);
  }

  /** False for a line that already left the buffer, whose late measurement must not count. */
  holds(seq: number) {
    return seq >= this.firstSeq;
  }

  commonHeight() {
    if (this.common === undefined) {
      let most = 0;
      for (const [height, lines] of this.linesByHeight) {
        if (lines > most) {
          most = lines;
          this.common = height;
        }
      }
    }
    return this.common ?? DEFAULT_ROW_HEIGHT;
  }

  set(seq: number, height: number) {
    const previous = this.bySeq.get(seq);
    if (previous === height) {
      return;
    }
    if (previous !== undefined) {
      this.uncount(previous);
    }
    this.bySeq.set(seq, height);
    const lines = (this.linesByHeight.get(height) ?? 0) + 1;
    this.linesByHeight.set(height, lines);
    if (this.common !== undefined && lines > (this.linesByHeight.get(this.common) ?? 0)) {
      this.common = height;
    }
  }

  /**
   * Lines numbered below `firstSeq` left the buffer for good. A small trim deletes their keys one by one; a trim
   * larger than the map walks the map instead.
   */
  forgetBefore(firstSeq: number) {
    const from = this.firstSeq;
    this.firstSeq = firstSeq;
    if (firstSeq - from <= this.bySeq.size) {
      for (let seq = from; seq < firstSeq; seq++) {
        this.delete(seq);
      }
      return;
    }
    for (const seq of this.bySeq.keys()) {
      if (seq < firstSeq) {
        this.delete(seq);
      }
    }
  }

  private delete(seq: number) {
    const height = this.bySeq.get(seq);
    if (height !== undefined) {
      this.bySeq.delete(seq);
      this.uncount(height);
    }
  }

  private uncount(height: number) {
    const lines = (this.linesByHeight.get(height) ?? 1) - 1;
    if (lines > 0) {
      this.linesByHeight.set(height, lines);
    } else {
      this.linesByHeight.delete(height);
    }
    if (height === this.common) {
      this.common = undefined;
    }
  }
}

/** react-window's dynamic row height protocol, with the rows it covers and the height it gives each line. */
type LineRowHeight = DynamicRowHeight & {
  rows: LineSeqSource;
  heightOf: (seq: number) => number;
};

/** The line whose row holds the view's top edge, and how far into that row the edge sits, in px. */
type Anchor = { seq: number; into: number };

/** The row that holds `offset`, at the heights `rowHeight` gives the rows, as the List places them. */
function anchorAt(rowHeight: LineRowHeight, offset: number): Anchor | undefined {
  const { rows } = rowHeight;
  let top = 0;
  for (let index = 0; index < rows.filteredIndexes.length; index++) {
    const seq = lineSeqAt(index, rows);
    if (seq === undefined) {
      break;
    }
    const height = rowHeight.heightOf(seq);
    if (top + height > offset) {
      return { seq, into: offset - top };
    }
    top += height;
  }
  return undefined;
}

/**
 * The scroll offset that puts the view's top edge back where the anchor says, at the heights `rowHeight` gives the
 * rows. A line the filter now hides gives way to the next row shown. Undefined when the line left the buffer.
 */
function offsetFor(rowHeight: LineRowHeight, anchor: Anchor): number | undefined {
  const { rows } = rowHeight;
  if (anchor.seq < rows.firstLineSeq) {
    return undefined;
  }
  let top = 0;
  for (let index = 0; index < rows.filteredIndexes.length; index++) {
    const seq = lineSeqAt(index, rows);
    if (seq === undefined || seq >= anchor.seq) {
      return seq === anchor.seq ? top + anchor.into : top;
    }
    top += rowHeight.heightOf(seq);
  }
  return top;
}

/** What the list's scroll element lets this code do while the view does not follow the end. */
type PausedScroll = {
  /** True while the user drags the scrollbar thumb: then the browser owns the offset. */
  isDragging: () => boolean;
  /** Sets the scroll offset for a reason other than the user's scroll. */
  move: (element: HTMLElement, to: number) => void;
};

type BeforeListUpdateProps = { onBeforeUpdate: () => void };

/** Runs `onBeforeUpdate` before React changes the DOM, while the rows on screen are still the ones the user saw. */
class BeforeListUpdate extends React.Component<BeforeListUpdateProps> {
  override getSnapshotBeforeUpdate() {
    this.props.onBeforeUpdate();
    return null;
  }

  override componentDidUpdate() {}

  override render() {
    return null;
  }
}

/**
 * Row heights in react-window's dynamic row height protocol, kept per line sequence number, so a line keeps its
 * height when older lines leave the buffer or a filter moves it. The List measures every row it renders through
 * `observeRowElements`. The heights are mutable so that a measurement does not copy a map that can hold a height for
 * each of the buffer's lines, up to 200,000.
 *
 * A new object tells the List to rebuild its row positions, a pass over every row. A measurement asks for one only
 * when it differs from the height the List holds for that line, so a new line at the common height costs no pass
 * beyond the one its arrival already made.
 *
 * While the view does not follow the end, the content in view keeps its place. The estimate stays where it was, since
 * a changed estimate moves every line not measured yet, and those lines sit above the view. The view is anchored to
 * a line: the line at its top edge and how far into it the edge sits. The anchor is taken again only when something
 * other than this code moved the scroll offset, such as the user. After every commit, the scroll offset is set to
 * where that line starts at the heights the List now holds, plus that distance. Lines that leave the buffer, rows
 * measured late and a browser that rounds the offset then move nothing, and repeating it changes nothing. While the
 * user drags the scrollbar thumb, the offset is the browser's and nothing is set; the next commit anchors again.
 */
function useLineRowHeights(
  filteredIndexes: readonly number[],
  firstLineSeq: number,
  follow: boolean,
  listElement: HTMLElement | null,
  scroll: PausedScroll
): { rowHeight: LineRowHeight; beforeUpdate: () => void } {
  const [heights] = useState(() => new LineHeights(firstLineSeq));
  const [version, setVersion] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  /** The object the List was last rendered with. */
  const committedRef = useRef<LineRowHeight | null>(null);
  const followRef = useRef(follow);
  const listElementRef = useRef(listElement);
  const anchorRef = useRef<Anchor | undefined>(undefined);
  /** The scroll offset as this code last left it; another value means something else moved it. */
  const anchoredTopRef = useRef<number | undefined>(undefined);

  // If something other than this code moved the view since it was anchored, anchor it again to what the user sees.
  // It runs before the DOM changes and before a measurement changes a height, while the heights are still the ones
  // the List placed the rows with.
  const anchorIfMoved = useCallback(() => {
    const element = listElementRef.current;
    const committed = committedRef.current;
    if (!element || !committed || followRef.current || scroll.isDragging()) {
      return;
    }
    const top = element.scrollTop;
    if (anchorRef.current === undefined || top !== anchoredTopRef.current) {
      anchorRef.current = anchorAt(committed, top);
      anchoredTopRef.current = top;
    }
  }, [scroll]);

  const record = useCallback(
    (measured: ReadonlyArray<readonly [number, number]>) => {
      anchorIfMoved();
      const committed = committedRef.current;
      let moved = false;
      for (const [seq, size] of measured) {
        if (!heights.holds(seq)) {
          continue;
        }
        const held = committed?.heightOf(seq) ?? DEFAULT_ROW_HEIGHT;
        heights.set(seq, size);
        moved ||= held !== size;
      }
      if (moved) {
        setVersion(v => v + 1);
      }
    },
    [heights, anchorIfMoved]
  );

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

  useEffect(() => heights.forgetBefore(firstLineSeq), [heights, firstLineSeq]);

  const rowHeight = useMemo<LineRowHeight>(() => {
    const rows = { filteredIndexes, firstLineSeq };
    const estimate = follow
      ? heights.commonHeight()
      : (committedRef.current?.getAverageRowHeight() ?? DEFAULT_ROW_HEIGHT);
    return {
      rows,
      heightOf: seq => heights.get(seq) ?? estimate,
      getAverageRowHeight: () => estimate,
      getRowHeight: index => {
        const seq = lineSeqAt(index, rows);
        return seq === undefined ? undefined : heights.get(seq);
      },
      setRowHeight: (index, size) => {
        const seq = lineSeqAt(index, rows);
        if (seq !== undefined) {
          record([[seq, size]]);
        }
      },
      observeRowElements
    };
    // `version` stands for the mutable heights: a new object makes the List read them again.
  }, [filteredIndexes, firstLineSeq, follow, version, heights, observeRowElements, record]);

  useLayoutEffect(() => {
    followRef.current = follow;
    listElementRef.current = listElement;
    committedRef.current = rowHeight;
    if (follow || !listElement) {
      anchorRef.current = undefined;
      anchoredTopRef.current = undefined;
      return;
    }
    if (scroll.isDragging()) {
      anchorRef.current = undefined;
      return;
    }
    const anchor = anchorRef.current;
    const target = anchor ? offsetFor(rowHeight, anchor) : undefined;
    if (anchor && target === undefined) {
      // The line in view left the buffer: the first line left takes the top.
      scroll.move(listElement, 0);
    } else if (target !== undefined && target !== listElement.scrollTop) {
      scroll.move(listElement, target);
    }
    if (target === undefined) {
      anchorRef.current = anchorAt(rowHeight, listElement.scrollTop);
    }
    anchoredTopRef.current = listElement.scrollTop;
  }, [rowHeight, follow, listElement, scroll]);

  return { rowHeight, beforeUpdate: anchorIfMoved };
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
  // Set while the user drags the scrollbar thumb, or presses on the list outside its rows.
  const draggingRef = useRef(false);
  const pausedScroll = useMemo<PausedScroll>(
    () => ({
      isDragging: () => draggingRef.current,
      // The scroll listeners below see the offset this sets as their last one, so it does not read as a fast scroll
      // that widens the overscan.
      move: (element, to) => {
        element.scrollTop = to;
        overscanLastTopRef.current = element.scrollTop;
        lastTopRef.current = element.scrollTop;
        // The List picked its rows for the old offset, before this effect. The browser's scroll event would only
        // reach it on the next frame, so after a large move that frame would show no rows; tell it now.
        element.dispatchEvent(new Event('scroll'));
      }
    }),
    []
  );
  const { rowHeight, beforeUpdate } = useLineRowHeights(
    filteredIndexes,
    firstLineSeq,
    follow,
    listElement,
    pausedScroll
  );

  // A press on the scrollbar, or on the list itself rather than a row, hands the offset to the browser until release.
  useEffect(() => {
    const el = listElement;
    if (!el) return;
    const onDown = (event: PointerEvent) => {
      draggingRef.current = event.target === el || event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight;
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [listElement]);

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
        <>
          <BeforeListUpdate onBeforeUpdate={beforeUpdate} />
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
        </>
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
