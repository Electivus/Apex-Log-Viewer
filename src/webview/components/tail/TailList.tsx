import React, { useLayoutEffect, useRef } from 'react';
import type { Messages } from '../../i18n';
import { List, type ListImperativeAPI } from 'react-window';
import { apexLineStyle, categoryStyle, contentHighlightRules, highlightContent, parseApexLine } from '../../utils/tail';
import { useAdaptiveList } from '../../utils/useAdaptiveList';

type TailListProps = {
  lines: string[];
  filteredIndexes: number[];
  selectedIndex?: number;
  onSelectIndex: (idx: number) => void;
  colorize: boolean;
  running: boolean;
  listRef: React.RefObject<ListImperativeAPI | null>;
  t: Messages;
  onAtBottomChange?: (atBottom: boolean) => void;
};

export function TailList({
  lines,
  filteredIndexes,
  selectedIndex,
  onSelectIndex,
  colorize,
  running,
  listRef,
  t,
  onAtBottomChange
}: TailListProps) {
  const {
    outerRef,
    height,
    getItemSize,
    setRowHeight,
    overscanCount
  } = useAdaptiveList({
    listRef,
    defaultRowHeight: 18,
    itemCount: filteredIndexes.length
  });
  const atBottomRef = useRef<boolean | null>(null);

  const itemKey = (index: number) => filteredIndexes[index] ?? index;

  const sepStyle: React.CSSProperties = { opacity: 0.4 };
  const timeStyle: React.CSSProperties = { opacity: 0.6 };
  const debugMsgStyle: React.CSSProperties = { color: 'var(--vscode-charts-blue)' };

  const renderRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const fullIdx = filteredIndexes[index]!;
    const l = lines[fullIdx]!;
    return (
      <div role="row" style={{ ...style, overflow: 'hidden' }} onClick={() => onSelectIndex(fullIdx)}>
        <RowContent
          text={l}
          colorize={colorize}
          selected={selectedIndex === fullIdx}
          sepStyle={sepStyle}
          timeStyle={timeStyle}
          debugMsgStyle={debugMsgStyle}
          t={t}
          onMeasured={h => setRowHeight(index, h)}
        />
      </div>
    );
  };

  const onRowsRendered = (_: { startIndex: number; stopIndex: number }) => {
    // Reserved for future tail auto-paging; no-op today
  };

  // Empty state when nothing matches
  const showEmpty = filteredIndexes.length === 0;

  // Detect whether the list is scrolled to the bottom and notify parent on changes
  React.useEffect(() => {
    const el = listRef.current?.element;
    if (!el) return;
    const threshold = 4; // px
    const compute = () => {
      const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= threshold;
      if (atBottomRef.current !== atBottom) {
        atBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
      }
    };
    compute();
    const onScroll = () => {
      // throttle to next frame
      requestAnimationFrame(compute);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onAtBottomChange, height, filteredIndexes.length]);

  return (
    <div ref={outerRef} style={{ flex: '1 1 auto' }}>
      <div
        style={{
          border: '1px solid var(--vscode-editorWidget-border)',
          borderRadius: 4,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          fontSize: 'var(--vscode-editor-font-size, 12px)',
          lineHeight: 1.4,
          overflow: 'hidden',
          height: height
        }}
      >
        {showEmpty ? (
          <div style={{ opacity: 0.7, padding: 8 }}>
            {running ? (t.tail?.waiting ?? 'Waiting for logs…') : (t.tail?.pressStart ?? 'Press Start to tail logs.')}
          </div>
        ) : (
          <List
            listRef={listRef}
            style={{ height, width: '100%' }}
            rowCount={filteredIndexes.length}
            rowHeight={(index: number) => getItemSize(index)}
            overscanCount={overscanCount}
            rowProps={{}}
            onRowsRendered={onRowsRendered}
            rowComponent={(props: { index: number; style: React.CSSProperties }) => renderRow(props)}
          />
        )}
      </div>
    </div>
  );
}

function RowContent({
  text,
  colorize,
  selected,
  sepStyle,
  timeStyle,
  debugMsgStyle,
  t,
  onMeasured
}: {
  text: string;
  colorize: boolean;
  selected: boolean;
  sepStyle: React.CSSProperties;
  timeStyle: React.CSSProperties;
  debugMsgStyle: React.CSSProperties;
  t: Messages;
  onMeasured: (h: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => onMeasured((el.scrollHeight || el.getBoundingClientRect().height) + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('TailList(RowContent): failed to disconnect ResizeObserver', e);
      }
    };
  }, [text, onMeasured, colorize, selected]);

  const commonStyle: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    background: selected ? 'var(--vscode-editor-selectionBackground)' : 'transparent',
    outline: selected ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
    borderLeft: selected ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
    paddingLeft: 4,
    cursor: 'pointer'
  };

  if (!colorize) {
    return (
      <div ref={ref} style={commonStyle}>
        {text}
      </div>
    );
  }

  const parsed = parseApexLine(text);
  const cat = parsed.category;
  const catSty = categoryStyle(cat, text);
  const lineFallback = apexLineStyle(text, colorize);

  if (!parsed.time && !cat) {
    const segs = highlightContent(text, contentHighlightRules);
    return (
      <div
        ref={ref}
        style={{
          ...commonStyle,
          ...lineFallback,
          background: selected ? 'var(--vscode-editor-selectionBackground)' : lineFallback.background || 'transparent'
        }}
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
    <div ref={ref} style={commonStyle}>
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
