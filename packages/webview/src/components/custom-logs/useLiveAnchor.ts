import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ListImperativeAPI } from 'react-window';

/**
 * Where the scroll offset must go so the row at the top of the viewport stays where it is after rows were
 * inserted above it, or undefined when the offset must not move: the list is at the top (it follows the new
 * rows), the row is gone, or the rows changed in a way other than insertion, such as a sort or a filter that
 * removed rows above it.
 */
export function anchoredScrollTop(params: {
  previous: readonly { id: string }[];
  rows: readonly { id: string }[];
  scrollTop: number;
  rowHeight: number;
}): number | undefined {
  const { previous, rows, scrollTop, rowHeight } = params;
  if (scrollTop <= 0 || previous.length === 0) {
    return undefined;
  }
  const anchorIndex = Math.min(previous.length - 1, Math.floor(scrollTop / rowHeight));
  const index = rows.findIndex(row => row.id === previous[anchorIndex]!.id);
  if (index < 0) {
    return undefined;
  }
  const known = new Set(previous.map(row => row.id));
  let inserted = 0;
  for (let position = 0; position < index; position++) {
    if (!known.has(rows[position]!.id)) {
      inserted++;
    }
  }
  return inserted > 0 && index - inserted === anchorIndex ? scrollTop + inserted * rowHeight : undefined;
}

/**
 * Keeps the user's place when live rows merge above it. A list scrolled to the top follows new rows; any other
 * position moves down by the height of the rows inserted above the first visible one, so the row under the
 * cursor does not move. Selection is by id already, so it survives the merge.
 */
export function useLiveAnchor(
  rows: readonly { id: string }[],
  rowHeight: number,
  listRef: RefObject<ListImperativeAPI | null>
): void {
  const previous = useRef(rows);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = rows;
    const element = listRef.current?.element;
    if (!element || before === rows) {
      return;
    }
    const scrollTop = anchoredScrollTop({ previous: before, rows, scrollTop: element.scrollTop, rowHeight });
    if (scrollTop !== undefined) {
      element.scrollTop = scrollTop;
    }
  }, [listRef, rowHeight, rows]);
}
