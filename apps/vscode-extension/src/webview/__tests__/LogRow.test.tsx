import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { LogRow } from '../components/table/LogRow';
import type { ApexLogRow } from '../../shared/types';

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
        logHead={{ '1': { codeUnitStarted: 'CU' } }}
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
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    expect(opened).toBe('1');
    opened = undefined;
    fireEvent.keyDown(rowEl, { key: ' ' });
    expect(opened).toBe('1');
    fireEvent.keyDown(rowEl, { key: 'Enter', shiftKey: true });
    expect(replayed).toBe('1');
  });
});
