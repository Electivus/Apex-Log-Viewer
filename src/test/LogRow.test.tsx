import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { LogRow } from '../webview/components/table/LogRow';
import type { ApexLogRow } from '../shared/types';
import { I18nProvider } from '../webview/i18n';

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
      <I18nProvider locale="en">
        <LogRow
          r={row}
          logHead={{ '1': { codeUnitStarted: 'CU' } }}
          locale="en-US"
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
      </I18nProvider>
    );
    getByText('User');
    fireEvent.click(getByRole('button', { name: 'Open' }));
    fireEvent.click(getByRole('button', { name: 'Replay' }));
    assert.equal(opened, '1');
    assert.equal(replayed, '1');

    opened = undefined;
    replayed = undefined;
    const rowEl = getByRole('row');
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    assert.equal(opened, '1');
    opened = undefined;
    fireEvent.keyDown(rowEl, { key: ' ' });
    assert.equal(opened, '1');
    fireEvent.keyDown(rowEl, { key: 'Enter', shiftKey: true });
    assert.equal(replayed, '1');
  });
});
