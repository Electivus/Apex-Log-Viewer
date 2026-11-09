import React, { useCallback, useEffect, useRef } from 'react';

import { syncHeaderScroll, useVirtualListElement } from '../table/useVirtualListElement';

/** Scroll `id` into view once it is among the items. A new `generation` asks again for the same id. */
export type RevealRequest = { id: string; generation: number };

/**
 * What the two virtual grids share: the header scrolls with the body, and Arrow keys move the selection
 * through the visible items. `onOpen` adds Enter for a grid whose rows open something, and `reveal` scrolls
 * an item into view on request. Pass `setListRef` as the List's `listRef`; `listRef` is for imperative calls
 * such as `scrollToRow`.
 */
export function useGridList<T extends { id: string }>(
  items: readonly T[],
  selectedId: string | undefined,
  onSelect: (item: T) => void,
  onOpen?: (item: T) => void,
  reveal?: RevealRequest
) {
  const { listRef, setListRef, element } = useVirtualListElement();
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!element || !header) {
      return;
    }
    const syncHeader = () => syncHeaderScroll(element, header);
    const syncBody = () => syncHeaderScroll(header, element);
    syncHeader();
    element.addEventListener('scroll', syncHeader, { passive: true });
    header.addEventListener('scroll', syncBody, { passive: true });
    return () => {
      element.removeEventListener('scroll', syncHeader);
      header.removeEventListener('scroll', syncBody);
    };
  }, [element]);

  // The item can arrive a render after the request, once the filters that hid it are relaxed, and the list's
  // handle after its first render; `element` changes with the handle, so either one runs this again.
  // `scrollToRow` tracks dynamic row heights until the row settles or its one-second deadline expires.
  // A wheel, touch, pointer or scroll key on the list also stops that tracking.
  const revealedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const list = listRef.current;
    if (!reveal || revealedRef.current === reveal.generation || !list) {
      return;
    }
    const index = items.findIndex(item => item.id === reveal.id);
    if (index < 0) {
      return;
    }
    revealedRef.current = reveal.generation;
    list.scrollToRow({ index, align: 'center', behavior: 'auto' });
  }, [element, items, listRef, reveal]);

  const selectedIndex = items.findIndex(item => item.id === selectedId);

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      const from = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : items.length;
      const index = Math.min(items.length - 1, Math.max(0, from + delta));
      const next = items[index];
      if (next) {
        onSelect(next);
        listRef.current?.scrollToRow({ index, align: 'smart', behavior: 'auto' });
      }
    },
    [items, onSelect, selectedIndex]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const selected = items[selectedIndex];
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter' && selected && onOpen) {
      event.preventDefault();
      onOpen(selected);
    }
  };

  return { listRef, setListRef, headerRef, onKeyDown };
}
