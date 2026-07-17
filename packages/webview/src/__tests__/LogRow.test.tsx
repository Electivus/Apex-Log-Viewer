import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { LogRow } from '../components/table/LogRow';
import type { ApexLogRow } from '@alv/protocol/types';

describe('LogRow', () => {
  it('renders data and callbacks fire', () => {
    const row: ApexLogRow = {
      Id: '1',
      StartTime: new Date().toISOString(),
      Operation: 'Op',
      Application: 'App',
      DurationMilliseconds: 1,
      Status: 'Success',
      Request: '',
      LogLength: 2048,
      LogUser: { Name: 'User' }
    };
    let opened: string | undefined;
    let replayed: string | undefined;
    const { getByRole, getByText } = render(
      <LogRow
        r={row}
        logHead={{}}
        locale="en-US"
        t={{ open: 'Open', replay: 'Replay' }}
        columns={['user']}
        loading={false}
        onOpen={id => {
          opened = id;
        }}
        onReplay={id => {
          replayed = id;
        }}
        gridTemplate="1fr 96px"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );
    getByText('User');
    fireEvent.click(getByRole('button', { name: 'Open' }));
    fireEvent.click(getByRole('button', { name: 'Replay' }));
    expect(opened).toBe('1');
    expect(replayed).toBe('1');

    opened = undefined;
    replayed = undefined;
    const rowEl = getByRole('row');
    expect(rowEl).toHaveAttribute('data-log-id', row.Id);
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    expect(opened).toBe('1');
    opened = undefined;
    fireEvent.keyDown(rowEl, { key: ' ' });
    expect(opened).toBe('1');
    fireEvent.keyDown(rowEl, { key: 'Enter', shiftKey: true });
    expect(replayed).toBe('1');
  });

  it('shows error badge on status column when error is detected', () => {
    const row: ApexLogRow = {
      Id: 'err-1',
      StartTime: new Date().toISOString(),
      Operation: 'Op',
      Application: 'App',
      DurationMilliseconds: 1,
      Status: 'Success',
      Request: '',
      LogLength: 2048,
      LogUser: { Name: 'User' }
    };
    render(
      <LogRow
        r={row}
        logHead={{ 'err-1': { hasErrors: true } }}
        locale="en-US"
        t={{ open: 'Open', replay: 'Replay', filters: { errorDetectedBadge: 'Error' } }}
        columns={['status']}
        loading={false}
        onOpen={() => {}}
        onReplay={() => {}}
        gridTemplate="1fr 96px"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('lets long Salesforce status text wrap inside the status column', () => {
    const row: ApexLogRow = {
      Id: 'long-status-1',
      StartTime: new Date().toISOString(),
      Operation: 'Op',
      Application: 'App',
      DurationMilliseconds: 1,
      Status:
        "Insert failed. First exception on row 0; first error: INVALID_INPUT, The selected language isn't currently supported. Apex error: List has no rows for assignment to SObject",
      Request: '',
      LogLength: 2048,
      LogUser: { Name: 'User' }
    };

    render(
      <LogRow
        r={row}
        logHead={{ 'long-status-1': { hasErrors: true, primaryReason: 'Validation failure' } as any }}
        locale="en-US"
        t={{ open: 'Open', replay: 'Replay', filters: { errorDetectedBadge: 'Error' } }}
        columns={['status']}
        loading={false}
        onOpen={() => {}}
        onReplay={() => {}}
        gridTemplate="220px 96px"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );

    const statusText = screen.getByTestId('logs-status-text');
    expect(statusText).toHaveTextContent('List has no rows for assignment to SObject');
    expect(statusText.className).toContain('min-w-0');
    expect(statusText.className).toContain('max-w-full');
    expect(statusText.className).toContain('whitespace-normal');
    expect(statusText.className).toContain('break-words');
    expect(statusText.className).not.toContain('shrink-0');
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Validation failure')).toBeInTheDocument();
  });

  it('shows a compact reason label next to the error badge', () => {
    const row: ApexLogRow = {
      Id: 'err-2',
      StartTime: new Date().toISOString(),
      Operation: 'Op',
      Application: 'App',
      DurationMilliseconds: 1,
      Status: 'Success',
      Request: '',
      LogLength: 2048,
      LogUser: { Name: 'User' }
    };
    render(
      <LogRow
        r={row}
        logHead={{ 'err-2': { hasErrors: true, primaryReason: 'Validation failure' } as any }}
        locale="en-US"
        t={{ open: 'Open', replay: 'Replay', filters: { errorDetectedBadge: 'Error' } }}
        columns={['status']}
        loading={false}
        onOpen={() => {}}
        onReplay={() => {}}
        gridTemplate="1fr 96px"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
    const reasonBadge = screen.getByTestId('logs-reason-badge');
    expect(reasonBadge).toHaveTextContent('Validation failure');
    expect(reasonBadge.className).not.toContain('truncate');
    expect(reasonBadge.className).not.toContain('shrink');
    expect(reasonBadge.className).toContain('max-w-full');
    expect(reasonBadge.className).toContain('whitespace-normal');

    const statusCell = reasonBadge.parentElement;
    expect(statusCell?.className ?? '').toContain('flex-wrap');
  });
});
