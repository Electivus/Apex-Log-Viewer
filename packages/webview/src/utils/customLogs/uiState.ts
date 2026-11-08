import React, { useEffect, useRef, useState } from 'react';
import type { SortState } from './columns';

/** Below this panel height the detail docks to the right; at or above it, under the table. */
const DETAIL_BOTTOM_MIN_HEIGHT_PX = 640;

export function detailDock(panelHeight: number): 'right' | 'bottom' {
  return panelHeight >= DETAIL_BOTTOM_MIN_HEIGHT_PX ? 'bottom' : 'right';
}

/**
 * What both Custom Logs webviews keep across a reload: the search, the sort, the hidden default columns, and
 * whether logger system messages show.
 */
export type PayloadUiState = {
  search: string;
  sort?: SortState;
  hiddenDefaults: string[];
  showSystem: boolean;
};

/** Whatever `vscode.getState()` returned, narrowed to a usable state. An old `payloadFilters` key is dropped. */
export function readPayloadUiState(saved: unknown): PayloadUiState {
  const raw = (typeof saved === 'object' && saved !== null ? saved : {}) as Partial<PayloadUiState>;
  const sort = raw.sort;
  return {
    search: typeof raw.search === 'string' ? raw.search : '',
    sort:
      sort && typeof sort.columnId === 'string' && (sort.dir === 'asc' || sort.dir === 'desc')
        ? { columnId: sort.columnId, dir: sort.dir }
        : undefined,
    hiddenDefaults: Array.isArray(raw.hiddenDefaults)
      ? raw.hiddenDefaults.filter(path => typeof path === 'string')
      : [],
    showSystem: raw.showSystem === true
  };
}

export function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      try {
        observer.disconnect();
      } catch (e) {
        console.warn('Custom Logs: failed to disconnect ResizeObserver', e);
      }
    };
  }, []);
  return [ref, height];
}
