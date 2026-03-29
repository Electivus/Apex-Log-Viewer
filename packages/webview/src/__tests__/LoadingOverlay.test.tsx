import React from 'react';
import { render, screen } from '@testing-library/react';
import { LoadingOverlay } from '../components/LoadingOverlay';

describe('LoadingOverlay component', () => {
  it('returns null when not shown and focuses container once visible', () => {
    const { rerender } = render(<LoadingOverlay show={false} label="Busy" />);
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<LoadingOverlay show label="Busy" />);
    const overlay = screen.getByRole('status');
    expect(overlay).toHaveAttribute('aria-label', 'Busy');
    expect(document.activeElement).toBe(overlay);
  });
});
