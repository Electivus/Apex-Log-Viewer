import assert from 'assert/strict';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { LogsHeader } from '../webview/components/table/LogsHeader';
import { I18nProvider } from '../webview/i18n';

suite('LogsHeader', () => {
  test('renders columns and handles sort', () => {
    let sorted: string | undefined;
    const { getByText } = render(
      <I18nProvider locale="en">
        <LogsHeader
          sortBy="user"
          sortDir="asc"
          onSort={key => {
            sorted = key;
          }}
          gridTemplate="1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr"
        />
      </I18nProvider>
    );
    fireEvent.click(getByText('Application'));
    assert.equal(sorted, 'application');
  });
});
