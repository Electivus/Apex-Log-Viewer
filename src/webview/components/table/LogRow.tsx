import React, { useLayoutEffect, useRef } from 'react';
import type { ApexLogRow } from '../../../shared/types';
import type { LogHeadMap } from '../LogsTable';
import { formatBytes, formatDuration } from '../../utils/format';
import { OpenIcon } from '../icons/OpenIcon';
import { ReplayIcon, SpinnerIcon } from '../icons/ReplayIcon';
import { IconButton } from '../IconButton';

type Props = {
  r: ApexLogRow;
  logHead: LogHeadMap;
  locale: string;
  t: any;
  loading: boolean;
  onOpen: (logId: string) => void;
  onReplay: (logId: string) => void;
  gridTemplate: string;
  style: React.CSSProperties;
  index: number;
  setRowHeight: (index: number, size: number) => void;
};

export function LogRow({
  r,
  logHead,
  locale,
  t,
  loading,
  onOpen,
  onReplay,
  gridTemplate,
  style,
  index,
  setRowHeight
}: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }

    const measure = () => {
      const h = el.scrollHeight || el.getBoundingClientRect().height;
      // add 1 for the row bottom border to avoid clipping
      setRowHeight(index, h + 1);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      try {
        ro.disconnect();
      } catch (e) {
        console.warn('LogRow: failed to disconnect ResizeObserver', e);
      }
    };
  }, [index, setRowHeight, logHead[r.Id]?.codeUnitStarted, r]);

  const baseCell: React.CSSProperties = {
    padding: 4,
    minWidth: 0,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word'
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only handle keys when the event originates on the row itself.
    // This avoids hijacking keyboard interactions of inner buttons.
    if (e.currentTarget !== e.target) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey) {
        onReplay(r.Id);
      } else {
        onOpen(r.Id);
      }
    }
  };

  return (
    <div
      role="row"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={e => (e.currentTarget.style.outline = '1px solid var(--vscode-focusBorder)')}
      onBlur={e => (e.currentTarget.style.outline = 'none')}
      style={{ ...style, outline: 'none' }}
    >
      <div
        ref={contentRef}
        style={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          alignItems: 'center',
          borderBottom: '1px solid var(--vscode-editorWidget-border)'
        }}
      >
        <div style={baseCell}>{r.LogUser?.Name ?? ''}</div>
        <div style={baseCell}>{r.Application}</div>
        <div style={baseCell}>{r.Operation}</div>
        <div style={baseCell}>{new Date(r.StartTime).toLocaleString(locale)}</div>
        <div style={baseCell}>{formatDuration(r.DurationMilliseconds)}</div>
        <div style={baseCell}>{r.Status}</div>
        <div style={baseCell} title={logHead[r.Id]?.codeUnitStarted ?? ''}>
          {logHead[r.Id]?.codeUnitStarted ?? ''}
        </div>
        <div style={{ ...baseCell, textAlign: 'right' }}>{formatBytes(r.LogLength)}</div>
        <div style={{ ...baseCell, textAlign: 'center' }}>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            <IconButton
              title={t.open ?? 'Open'}
              ariaLabel={t.open ?? 'Open'}
              disabled={loading}
              onClick={e => {
                e.stopPropagation();
                onOpen(r.Id);
              }}
            >
              {loading ? <SpinnerIcon /> : <OpenIcon />}
            </IconButton>
            <IconButton
              title={t.replay}
              ariaLabel={t.replay}
              disabled={loading}
              onClick={e => {
                e.stopPropagation();
                onReplay(r.Id);
              }}
            >
              {loading ? <SpinnerIcon /> : <ReplayIcon />}
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
