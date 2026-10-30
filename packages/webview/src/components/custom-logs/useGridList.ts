import React, { useCallback, useEffect, useRef } from 'react';
import type { ListImperativeAPI } from 'react-window';

/**
 * What the two virtual grids share: the header scrolls with the body, and Arrow keys move the selection
 * through the visible items. `onOpen` adds Enter for a grid whose rows open something.
 */
export function useGridList<T extends { id: string }>(
  items: readonly T[],
  selectedId: string | undefined,
  onSelect: (item: T) => void,
  onOpen?: (item: T) => void
) {
  const listRef = useRef<ListImperativeAPI | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = listRef.current?.element;
    if (!element) {
      return;
    }
    const syncHeader = () => {
      if (headerRef.current) {
        headerRef.current.scrollLeft = element.scrollLeft;
      }
    };
    element.addEventListener('scroll', syncHeader, { passive: true });
    return () => element.removeEventListener('scroll', syncHeader);
  }, []);

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

  return { listRef, headerRef, onKeyDown };
}
