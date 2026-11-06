import { useCallback, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';

/**
 * The scroll element of a react-window `List`, as state.
 *
 * `List` keeps its element in its own state, so `listRef.current.element` is still null after the first
 * commit, and a parent effect that reads it on mount never attaches. Pass `setListRef` as the List's
 * `listRef`: React calls it again with each new handle, and `element` re-renders the caller so effects
 * that depend on it attach to the real scroll element. `listRef` stays a plain ref for imperative calls.
 */
export function useVirtualListElement() {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const setListRef = useCallback((api: ListImperativeAPI | null) => {
    listRef.current = api;
    setElement(api?.element ?? null);
  }, []);
  return { listRef, setListRef, element };
}

/**
 * Reserves the vertical scrollbar's width on a table body and on its header alike. The header sits outside the
 * scroll container, so without it a scrollbar narrows only the body's flexible track and every column after
 * that track starts left of its header.
 */
export const SCROLLBAR_GUTTER = '[scrollbar-gutter:stable]';

/** Keeps a header that sits outside the scroll container at the body's horizontal scroll position. */
export function syncHeaderScroll(element: HTMLElement, header: HTMLElement | null): void {
  if (header && header.scrollLeft !== element.scrollLeft) {
    header.scrollLeft = element.scrollLeft;
  }
}
