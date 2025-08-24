import React from 'react';
import type { ApexLogRow } from '../../../shared/types';
import type { LogHeadMap } from '../LogsTable';
import { formatBytes } from '../../utils/format';
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
};

export function LogRow({ r, logHead, locale, t, loading, onOpen, onReplay, gridTemplate, style }: Props) {
  return (
    <div
      role="row"
      style={{
        ...style,
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        alignItems: 'center',
        borderBottom: '1px solid var(--vscode-editorWidget-border)'
      }}
    >
      <div style={{ padding: 4 }}>{r.LogUser?.Name ?? ''}</div>
      <div style={{ padding: 4 }}>{r.Application}</div>
      <div style={{ padding: 4 }}>{r.Operation}</div>
      <div style={{ padding: 4 }}>{new Date(r.StartTime).toLocaleString(locale)}</div>
      <div style={{ padding: 4 }}>{r.Status}</div>
      <div style={{ padding: 4 }}>{logHead[r.Id]?.codeUnitStarted ?? ''}</div>
      <div style={{ padding: 4, textAlign: 'right' }}>{formatBytes(r.LogLength)}</div>
      <div style={{ padding: 4, textAlign: 'center' }}>
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
            <OpenIcon />
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
  );
}
