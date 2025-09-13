import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';

export interface AdaptiveListOptions {
  listRef: React.RefObject<ListImperativeAPI | null>;
  defaultRowHeight: number;
  itemCount: number;
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  headerRef?: React.RefObject<HTMLElement | null>;
}

export function useAdaptiveList({
  listRef,
  defaultRowHeight,
  itemCount,
  hasMore = false,
  loading = false,
  onLoadMore,
  headerRef
}: AdaptiveListOptions) {
  const rowHeightsRef = useRef<Record<number, number>>({});
  const [height, setHeight] = useState<number>(420);
  const outerRef = useRef<HTMLDivElement | null>(null);

  const overscanBaseRef = useRef<number>(8);
  const [overscanCount, setOverscanCount] = useState<number>(overscanBaseRef.current);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(overscanBaseRef.current);

  const hasMoreRef = useRef<boolean>(hasMore);
  const loadingRef = useRef<boolean>(loading);
  const itemCountRef = useRef<number>(itemCount);
  const lastLoadTsRef = useRef<number>(0);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    itemCountRef.current = itemCount;
  }, [itemCount]);

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

  const getItemSize = (index: number) => rowHeightsRef.current[index] ?? defaultRowHeight;

  useLayoutEffect(() => {
    const recompute = () => {
      const outerRect = outerRef.current?.getBoundingClientRect();
      const headerRect = headerRef?.current?.getBoundingClientRect();
      const top = outerRect?.top ?? 0;
      const headerH = headerRect?.height ?? 0;
      const available = Math.max(160, Math.floor(window.innerHeight - top - headerH - 12));
      setHeight(available);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (outerRef.current) ro.observe(outerRef.current);
    if (headerRef?.current) ro.observe(headerRef.current);
    window.addEventListener('resize', recompute);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('useAdaptiveList: failed to disconnect ResizeObserver', e);
      }
      window.removeEventListener('resize', recompute);
    };
  }, [headerRef]);

  useEffect(() => {
    const el = listRef.current?.element as HTMLElement | undefined;
    if (!el) return;
    const onScroll = () => {
      const now = performance.now();
      const dt = now - (overscanLastTsRef.current || now);
      const dy = Math.abs(el.scrollTop - (overscanLastTopRef.current || 0));
      if (dt > 16) {
        const v = dy / dt;
        let next = overscanBaseRef.current;
        if (v > 2) next = 22;
        else if (v > 1) next = 14;
        else if (v > 0.4) next = 10;
        else next = overscanBaseRef.current;
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
      if (hasMoreRef.current && !loadingRef.current && onLoadMore) {
        const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (remaining <= defaultRowHeight * 2) {
          if (now - lastLoadTsRef.current > 300) {
            lastLoadTsRef.current = now;
            onLoadMore();
          }
        }
      }
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onLoadMore, defaultRowHeight, listRef]);

  const onRowsRendered = ({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) => {
    if (!onLoadMore) return;
    const visibleStopIndex = stopIndex;
    const approxVisible = Math.max(5, Math.ceil(height / defaultRowHeight));
    const threshold = Math.max(0, itemCountRef.current - (approxVisible + 5));
    if (hasMoreRef.current && !loadingRef.current && visibleStopIndex >= threshold) {
      onLoadMore();
    }
  };

  return {
    outerRef,
    height,
    getItemSize,
    setRowHeight,
    overscanCount,
    onRowsRendered
  };
}

