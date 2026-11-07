import React from 'react';
import { render, screen } from '@testing-library/react';
import { LogsStatusStrip } from '../components/LogsStatusStrip';
import { getMessages } from '../i18n';

const t = getMessages('en');

function renderStrip(props: Partial<React.ComponentProps<typeof LogsStatusStrip>> = {}) {
  return render(<LogsStatusStrip t={t} loading={false} searchLoading={false} {...props} />);
}

describe('LogsStatusStrip', () => {
  it('renders nothing while there is nothing to say', () => {
    renderStrip();
    expect(screen.queryByTestId('logs-status-strip')).toBeNull();
  });

  it('shows the loading message with a spinner', () => {
    renderStrip({ loading: true });
    const notice = screen.getByText('Loading…');
    expect(notice.parentElement?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows an error as an alert and lets it replace the loading message', () => {
    renderStrip({ loading: true, error: 'Request failed' });
    expect(screen.getByRole('alert')).toHaveTextContent('Error: Request failed');
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('shows a warning as a status', () => {
    renderStrip({ warning: 'sourceApiVersion 66.0 > org max 64.0; falling back to 64.0' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Warning: sourceApiVersion 66.0 > org max 64.0; falling back to 64.0'
    );
  });

  it('shows a spinner while the search prepares', () => {
    renderStrip({ searchLoading: true, searchMessage: 'Preparing…' });
    expect(screen.getByText('Preparing…').parentElement?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows search information without a spinner when the search is not running', () => {
    renderStrip({ searchMessage: 'Waiting for logs…' });
    expect(screen.getByText('Waiting for logs…').parentElement?.querySelector('.animate-spin')).toBeNull();
  });

  it('shows the error scan progress', () => {
    renderStrip({ scanMessage: 'Scanning logs for errors…' });
    expect(screen.getByText('Scanning logs for errors…')).toBeInTheDocument();
  });
});
