import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ListImperativeAPI } from 'react-window';

export function useVirtualList({
  listRef,
  defaultRowHeight,
  headerRef
}: {
  listRef: React.RefObject<ListImperativeAPI | null>;
  defaultRowHeight: number;
  headerRef?: React.RefObject<HTMLElement | null>;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>(420);

  const rowHeightsRef = useRef<Record<number, number>>({});

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
    const current = rowHeightsRef.current[index] ?? defaultRowHeight;
    const next = Math.max(defaultRowHeight, Math.ceil(size));
    if (current !== next) {
      rowHeightsRef.current[index] = next;
      scheduleRerender();
    }
  };

  const getItemSize = (index: number) => rowHeightsRef.current[index] ?? defaultRowHeight;

  useLayoutEffect(() => {
    const recompute = () => {
      const outerRect = outerRef.current?.getBoundingClientRect();
      const top = outerRect?.top ?? 0;
      const headerH = headerRef?.current?.getBoundingClientRect().height ?? 0;
      const available = Math.max(160, Math.floor(window.innerHeight - top - headerH - 12));
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
        console.warn('useVirtualList: failed to disconnect ResizeObserver', e);
      }
      window.removeEventListener('resize', recompute);
    };
  }, [headerRef]);

  const [overscanCount, setOverscanCount] = useState<number>(8);
  const overscanBaseRef = useRef<number>(8);
  const overscanLastTopRef = useRef<number>(0);
  const overscanLastTsRef = useRef<number>(0);
  const overscanDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overscanLastSetRef = useRef<number>(8);

  useEffect(() => {
    const el = listRef.current?.element;
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
      overscanLastTsRef.current = now;
      overscanLastTopRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [listRef]);

  return { outerRef, height, setRowHeight, getItemSize, overscanCount };
}

