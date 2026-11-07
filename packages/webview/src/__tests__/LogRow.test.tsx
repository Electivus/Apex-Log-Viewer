import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { LogRow } from '../components/table/LogRow';
import type { LogsColumnKey } from '@alv/protocol/logsColumns';
import type { ApexLogRow } from '@alv/protocol/types';

function makeRow(overrides: Partial<ApexLogRow> = {}): ApexLogRow {
  return {
    Id: '1',
    StartTime: new Date().toISOString(),
    Operation: 'Op',
    Application: 'App',
    DurationMilliseconds: 1,
    Status: 'Success',
    Request: '',
    LogLength: 2048,
    LogUser: { Name: 'User' },
    ...overrides
  };
}

const messages = { open: 'Open', replay: 'Replay', filters: { errorDetectedBadge: 'Error' } };

function renderRow({
  row = makeRow(),
  columns = ['user'],
  logHead = {},
  matchSnippet
}: {
  row?: ApexLogRow;
  columns?: LogsColumnKey[];
  logHead?: Record<string, any>;
  matchSnippet?: { text: string; ranges: [number, number][] };
} = {}) {
  const opened: string[] = [];
  const replayed: string[] = [];
  render(
    <LogRow
      r={row}
      logHead={logHead}
      matchSnippet={matchSnippet}
      locale="en-US"
      t={messages}
      columns={columns}
      onOpen={id => opened.push(id)}
      onReplay={id => replayed.push(id)}
      gridTemplate="1fr 72px"
      minWidthPx={400}
      style={{}}
    />
  );
  return { opened, replayed, rowEl: screen.getByRole('row') };
}

describe('LogRow', () => {
  it('renders data and the Open and Replay actions fire once each', () => {
    const { opened, replayed, rowEl } = renderRow();
    screen.getByText('User');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(opened).toEqual(['1']);
    expect(replayed).toEqual(['1']);
    expect(rowEl).toHaveAttribute('data-log-id', '1');
  });

  it('keeps Enter, Space and Shift+Enter on the focused row', () => {
    const { opened, replayed, rowEl } = renderRow();
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    fireEvent.keyDown(rowEl, { key: ' ' });
    expect(opened).toEqual(['1', '1']);
    fireEvent.keyDown(rowEl, { key: 'Enter', shiftKey: true });
    expect(replayed).toEqual(['1']);
  });

  describe('click to open', () => {
    afterEach(() => {
      window.getSelection()?.removeAllRanges();
    });

    it('opens the log on a click anywhere on the row', () => {
      const { opened, rowEl } = renderRow();
      expect(rowEl.className).toContain('cursor-pointer');
      fireEvent.click(screen.getByText('User'));
      expect(opened).toEqual(['1']);
    });

    it('does not open twice on a double click', () => {
      const { opened } = renderRow();
      const cell = screen.getByText('User');
      fireEvent.click(cell, { detail: 1 });
      fireEvent.click(cell, { detail: 2 });
      expect(opened).toEqual(['1']);
    });

    it('does not open when the user selected text', () => {
      const { opened } = renderRow();
      const cell = screen.getByText('User');
      window.getSelection()?.selectAllChildren(cell);
      fireEvent.click(cell);
      expect(opened).toEqual([]);
    });

    it('lets a button act without also opening the row', () => {
      const { opened, replayed } = renderRow();
      fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
      expect(replayed).toEqual(['1']);
      expect(opened).toEqual([]);
    });
  });

  it('pins the actions at the right edge with 24 px buttons', () => {
    renderRow();
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open.className).toContain('h-6');
    expect(open.className).toContain('w-6');
    expect(open.parentElement?.className).toContain('sticky');
    expect(open.parentElement?.className).toContain('right-0');
  });

  describe('status cell', () => {
    const longStatus =
      "Insert failed. First exception on row 0; first error: INVALID_INPUT, The selected language isn't currently supported. Apex error: List has no rows for assignment to SObject";

    it('shows the error badge when an error is detected', () => {
      renderRow({ columns: ['status'], logHead: { '1': { hasErrors: true } } });
      expect(screen.getByTestId('logs-error-badge')).toHaveTextContent('Error');
    });

    it('stays on one line and keeps the full status and reason in the title', () => {
      renderRow({
        row: makeRow({ Status: longStatus }),
        columns: ['status'],
        logHead: { '1': { hasErrors: true, primaryReason: 'Validation failure' } }
      });
      const statusText = screen.getByTestId('logs-status-text');
      const cell = statusText.parentElement as HTMLElement;
      expect(statusText).toHaveTextContent('List has no rows for assignment to SObject');
      expect(statusText.className).toContain('truncate');
      expect(statusText.className).not.toContain('whitespace-normal');
      expect(cell.className).not.toContain('flex-wrap');
      expect(cell).toHaveAttribute('title', `${longStatus} · Validation failure`);
    });

    it('keeps the error badge whole and lets the reason shrink', () => {
      renderRow({ columns: ['status'], logHead: { '1': { hasErrors: true, primaryReason: 'Validation failure' } } });
      expect(screen.getByTestId('logs-error-badge').className).toContain('shrink-0');
      const reason = screen.getByTestId('logs-reason-badge');
      expect(reason).toHaveTextContent('Validation failure');
      expect(reason).toHaveAttribute('title', 'Validation failure');
      expect(reason.className).not.toContain('whitespace-normal');
    });
  });

  describe('operation cell', () => {
    it('truncates the head of a path and keeps its last segment whole', () => {
      renderRow({
        row: makeRow({ Operation: '/services/data/v60.0/tooling/executeAnonymous' }),
        columns: ['operation']
      });
      const tail = screen.getByText('executeAnonymous');
      expect(tail.className).toContain('shrink-0');
      expect(screen.getByText('/services/data/v60.0/tooling/').className).toContain('truncate');
      expect(tail.parentElement).toHaveAttribute('title', '/services/data/v60.0/tooling/executeAnonymous');
    });

    it('truncates a value without a slash as a whole', () => {
      renderRow({ row: makeRow({ Operation: 'ApexTestHandler' }), columns: ['operation'] });
      expect(screen.getByText('ApexTestHandler').className).toContain('truncate');
    });
  });

  describe('match cell', () => {
    it('highlights the hit on one line, keeping it in view when the context is long', () => {
      const text = `...${'x'.repeat(60)}NEEDLE and the rest`;
      renderRow({ columns: ['match'], matchSnippet: { text, ranges: [[63, 69]] } });
      const mark = screen.getByText('NEEDLE');
      expect(mark.tagName).toBe('MARK');
      const cell = mark.parentElement as HTMLElement;
      expect(cell.className).toContain('truncate');
      expect(cell.textContent?.startsWith('…')).toBe(true);
      expect(cell).toHaveAttribute('title', text);
    });

    it('shows a dash when the row matched only on its metadata', () => {
      renderRow({ columns: ['match'] });
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });
});
