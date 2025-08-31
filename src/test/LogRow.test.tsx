import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { LogRow } from '../webview/components/table/LogRow';
import type { ApexLogRow } from '../shared/types';

suite('LogRow', () => {
  test('renders data and callbacks fire', () => {
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
        loading={false}
        onOpen={id => {
          opened = id;
        }}
        onReplay={id => {
          replayed = id;
        }}
        gridTemplate="1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr"
        style={{}}
        index={0}
        setRowHeight={() => {}}
      />
    );
    getByText('User');
    fireEvent.click(getByRole('button', { name: 'Open' }));
    fireEvent.click(getByRole('button', { name: 'Replay' }));
    assert.equal(opened, '1');
    assert.equal(replayed, '1');
  });
});
