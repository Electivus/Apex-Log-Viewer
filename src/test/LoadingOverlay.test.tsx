import assert from 'assert/strict';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LoadingOverlay } from '../webview/components/LoadingOverlay';

suite('LoadingOverlay component', () => {
  test('returns null when not shown and focuses container once visible', () => {
    const { rerender } = render(<LoadingOverlay show={false} label="Busy" />);
    assert.equal(screen.queryByRole('status'), null, 'overlay hidden when show=false');

    rerender(<LoadingOverlay show label="Busy" />);
    const overlay = screen.getByRole('status');
    assert.equal(overlay.getAttribute('aria-label'), 'Busy');
    assert.equal(document.activeElement, overlay, 'overlay receives focus for accessibility');
  });
});
