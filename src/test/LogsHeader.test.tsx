import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { LogsHeader } from '../webview/components/table/LogsHeader';

suite('LogsHeader', () => {
  test('renders columns and handles sort', () => {
    let sorted: string | undefined;
    const t = {
      columns: {
        user: 'User',
        application: 'Application',
        operation: 'Operation',
        time: 'Time',
        status: 'Status',
        codeUnitStarted: 'Code Unit',
        size: 'Size'
      }
    };
    const { getByText } = render(
      <LogsHeader
        t={t}
        sortBy="user"
        sortDir="asc"
        onSort={key => {
          sorted = key;
        }}
        gridTemplate="1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr"
      />
    );
    fireEvent.click(getByText('Application'));
    assert.equal(sorted, 'application');
  });
});
