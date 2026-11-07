import React from 'react';
import { render, screen } from '@testing-library/react';
import { LoadingOverlay } from '../components/LoadingOverlay';

describe('LoadingOverlay component', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // One webview document, in order: the overlay remembers that the document has already loaded.
  it('takes outside focus only on the first overlay of a webview document', () => {
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { rerender } = render(<LoadingOverlay show={false} label="Busy" />);
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<LoadingOverlay show label="Busy" />);
    const firstOverlay = screen.getByRole('status');
    expect(firstOverlay).toHaveAttribute('aria-label', 'Busy');
    expect(document.activeElement).toBe(firstOverlay);

    rerender(<LoadingOverlay show={false} label="Busy" />);
    const activeBeforeReload = document.activeElement;
    rerender(<LoadingOverlay show label="Busy" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Busy');
    expect(document.activeElement).toBe(activeBeforeReload);

    rerender(<LoadingOverlay show={false} label="Busy" />);
    hasFocus.mockReturnValue(true);
    rerender(<LoadingOverlay show label="Busy" />);
    expect(document.activeElement).toBe(screen.getByRole('status'));
  });
});
