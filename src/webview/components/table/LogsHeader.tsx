import React from 'react';

type SortKey = 'user' | 'application' | 'operation' | 'time' | 'duration' | 'status' | 'size' | 'codeUnit';

type Props = {
  t: any;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  gridTemplate: string;
};

export const LogsHeader = React.forwardRef<HTMLDivElement, Props>(
  ({ t, sortBy, sortDir, onSort, gridTemplate }, ref) => {
    const sortableStyle: React.CSSProperties = { cursor: 'pointer' };
    const sortArrow = (key: string) => {
      if (sortBy !== (key as any)) {
        return null;
      }
      return (
        <span aria-hidden style={{ marginLeft: 4 }}>
          {sortDir === 'asc' ? '▲' : '▼'}
        </span>
      );
    };

    return (
      <div
        ref={ref}
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          alignItems: 'center',
          borderBottom: '1px solid var(--vscode-editorWidget-border)',
          padding: '4px 0',
          fontWeight: 600,
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background, transparent))'
        }}
      >
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'user' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('user')}
        >
          {t.columns.user}
          {sortArrow('user')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'application' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('application')}
        >
          {t.columns.application}
          {sortArrow('application')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'operation' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('operation')}
        >
          {t.columns.operation}
          {sortArrow('operation')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'time' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('time')}
        >
          {t.columns.time}
          {sortArrow('time')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'duration' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('duration')}
        >
          {t.columns.duration}
          {sortArrow('duration')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'status' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('status')}
        >
          {t.columns.status}
          {sortArrow('status')}
        </div>
        <div
          role="columnheader"
          style={sortableStyle}
          aria-sort={sortBy === 'codeUnit' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('codeUnit')}
        >
          {t.columns.codeUnitStarted}
          {sortArrow('codeUnit')}
        </div>
        <div
          role="columnheader"
          style={{ textAlign: 'right', cursor: 'pointer' }}
          aria-sort={sortBy === 'size' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
          onClick={() => onSort('size')}
        >
          {t.columns.size}
          {sortArrow('size')}
        </div>
        <div aria-hidden />
      </div>
    );
  }
);

LogsHeader.displayName = 'LogsHeader';
