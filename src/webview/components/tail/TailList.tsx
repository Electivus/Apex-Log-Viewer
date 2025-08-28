import React from 'react';
import type { Messages } from '../../i18n';
import { apexLineStyle, categoryStyle, contentHighlightRules, highlightContent, parseApexLine } from '../../utils/tail';

type TailListProps = {
  lines: string[];
  filteredIndexes: number[];
  selectedIndex?: number;
  onSelectIndex: (idx: number) => void;
  colorize: boolean;
  running: boolean;
  listRef: React.RefObject<HTMLDivElement>;
  registerLineRef: (idx: number, el: HTMLDivElement | null) => void;
  t: Messages;
};

export function TailList({
  lines,
  filteredIndexes,
  selectedIndex,
  onSelectIndex,
  colorize,
  running,
  listRef,
  registerLineRef,
  t
}: TailListProps) {
  const sepStyle: React.CSSProperties = { opacity: 0.4 };
  const timeStyle: React.CSSProperties = { opacity: 0.6 };
  const debugMsgStyle: React.CSSProperties = { color: 'var(--vscode-charts-blue)' };

  return (
    <div
      ref={listRef}
      style={{
        border: '1px solid var(--vscode-editorWidget-border)',
        borderRadius: 4,
        padding: 8,
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: 'var(--vscode-editor-font-size, 12px)',
        lineHeight: 1.4,
        overflow: 'auto',
        flex: '1 1 auto',
        maxHeight: '70vh'
      }}
    >
      {filteredIndexes.length === 0 && (
        <div style={{ opacity: 0.7 }}>{running ? t.tail?.waiting ?? 'Waiting for logs…' : t.tail?.pressStart ?? 'Press Start to tail logs.'}</div>
      )}
      {filteredIndexes.map(fullIdx => {
        const l = lines[fullIdx];
        const commonProps = {
          key: fullIdx,
          ref: (el: HTMLDivElement | null) => registerLineRef(fullIdx, el),
          onClick: () => onSelectIndex(fullIdx),
          tabIndex: 0 as const
        };
        if (!colorize) {
          return (
            <div
              {...commonProps}
              style={{
                whiteSpace: 'pre-wrap',
                background: selectedIndex === fullIdx ? 'var(--vscode-editor-selectionBackground)' : 'transparent',
                outline:
                  selectedIndex === fullIdx ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
                borderLeft: selectedIndex === fullIdx ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
                paddingLeft: 4,
                cursor: 'pointer'
              }}
            >
              {l}
            </div>
          );
        }

        const parsed = parseApexLine(l);
        const cat = parsed.category;
        const catStyle = categoryStyle(cat, l);
        const lineFallback = apexLineStyle(l, colorize);

        // If we don't have a category and time, fallback to whole-line coloring
        if (!parsed.time && !cat) {
          const segs = highlightContent(l, contentHighlightRules);
          return (
            <div
              {...commonProps}
              style={{
                whiteSpace: 'pre-wrap',
                ...lineFallback,
                background:
                  selectedIndex === fullIdx
                    ? 'var(--vscode-editor-selectionBackground)'
                    : lineFallback.background || 'transparent',
                outline:
                  selectedIndex === fullIdx ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
                borderLeft: selectedIndex === fullIdx ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
                paddingLeft: 4,
                cursor: 'pointer'
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
          <div
            {...commonProps}
            style={{
              whiteSpace: 'pre-wrap',
              background: selectedIndex === fullIdx ? 'var(--vscode-editor-selectionBackground)' : 'transparent',
              outline: selectedIndex === fullIdx ? '1px solid var(--vscode-contrastActiveBorder, transparent)' : 'none',
              borderLeft: selectedIndex === fullIdx ? '3px solid var(--vscode-focusBorder)' : '3px solid transparent',
              paddingLeft: 4,
              cursor: 'pointer'
            }}
          >
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
                <span style={catStyle}>{cat}</span>
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
      })}
    </div>
  );
}
