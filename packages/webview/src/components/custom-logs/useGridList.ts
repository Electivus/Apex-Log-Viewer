import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer, type DynamicRowHeight } from 'react-window';

/** Scroll `id` into view once it is among the items. A new `generation` asks again for the same id. */
export type RevealRequest = { id: string; generation: number };

/**
 * What the two virtual grids share. The header and the rows live in one scroller (`setScroller`), so horizontal
 * scroll and the scrollbar cannot misalign them; `setBody` is the rows' box. Arrow keys move the selection
 * through the items, `onOpen` adds Enter for a grid whose rows open something, and `reveal` scrolls an item
 * into view on request. Both reveals stop below the sticky header through the scroller's `scroll-padding-top`.
 */
export function useGridList<T extends { id: string }>(
  items: readonly T[],
  selectedId: string | undefined,
  onSelect: (item: T) => void,
  options: {
    itemSize: number | DynamicRowHeight;
    overscanCount: number;
    onOpen?: (item: T) => void;
    reveal?: RevealRequest;
  }
) {
  const { itemSize, overscanCount, onOpen, reveal } = options;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    element: body,
    scrollElement: scroller,
    itemSize,
    overscanCount,
    defaultSize: 600
  });
  const scrollToIndexRef = useRef(virtualizer.scrollToIndex);
  scrollToIndexRef.current = virtualizer.scrollToIndex;

  // The item can arrive a render after the request, once the filters that hid it are relaxed, and the scroller
  // after the first render. `scrollToIndex` tracks dynamic row heights until the row settles or its one-second
  // deadline expires. A wheel, touch, pointer or scroll key on the scroller also stops that tracking.
  const revealedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!reveal || revealedRef.current === reveal.generation || !scroller || !body) {
      return;
    }
    const index = items.findIndex(item => item.id === reveal.id);
    if (index < 0) {
      return;
    }
    revealedRef.current = reveal.generation;
    scrollToIndexRef.current({ index, align: 'center', behavior: 'auto' });
  }, [body, items, reveal, scroller]);

  const selectedIndex = items.findIndex(item => item.id === selectedId);

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      const from = selectedIndex >= 0 ? selectedIndex : delta > 0 ? -1 : items.length;
      const index = Math.min(items.length - 1, Math.max(0, from + delta));
      const next = items[index];
      if (next) {
        onSelect(next);
        scrollToIndexRef.current({ index, align: 'smart', behavior: 'auto' });
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

  return {
    scroller,
    setScroller,
    setBody,
    virtualItems: virtualizer.items,
    measureElement: virtualizer.measureElement,
    totalSize: virtualizer.totalSize,
    onKeyDown
  };
}
