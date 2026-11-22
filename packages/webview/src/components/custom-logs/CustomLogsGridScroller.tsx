import React from 'react';

/**
 * The one scroller both Custom Logs grids share. The sticky header and the rows sit in it together, so a scrollbar
 * or a horizontal scroll moves them as one, and `scroll-padding-top` makes every scroll-into-view (the reveal,
 * the arrow keys, Tab focus) stop below the header instead of under it. The 25px is the header's 24px row and
 * its 1px border.
 */
export function GridScroller({
  setScroller,
  setBody,
  totalWidth,
  totalSize,
  header,
  children
}: {
  setScroller: (element: HTMLDivElement | null) => void;
  setBody: (element: HTMLDivElement | null) => void;
  totalWidth: number;
  totalSize: number;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={setScroller} className="absolute inset-0 overflow-auto scroll-pt-[25px]">
        <div style={{ minWidth: totalWidth }}>
          {header}
          <div ref={setBody} className="relative" style={{ height: totalSize }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
