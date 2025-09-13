import assert from 'assert/strict';
import React from 'react';
import { render } from '@testing-library/react';
import { ErrorBoundary } from '../../webview/components/ErrorBoundary';

suite('ErrorBoundary', () => {
  test('renders fallback UI on error with reload', () => {
    const Boom = () => {
      throw new Error('Boom');
    };
    const { getByText } = render(
      <ErrorBoundary showReload>
        <Boom />
      </ErrorBoundary>
    );
    assert.ok(getByText(/Something went wrong/i));
    assert.ok(getByText(/Reload/i));
  });
});

