import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { ColumnsPopover } from '../components/ColumnsPopover';
import { getMessages } from '../i18n';

const initialColumnsConfig = {
  order: [
    'user',
    'application',
    'operation',
    'time',
    'duration',
    'status',
    'codeUnit',
    'size',
    'match'
  ],
  visibility: {
    user: true,
    application: true,
    operation: true,
    time: true,
    duration: true,
    status: true,
    codeUnit: true,
    size: true,
    match: true
  },
  widths: {}
} as const;

function Harness({ fullLogSearchEnabled }: { fullLogSearchEnabled: boolean }) {
  const t = getMessages('en');
  const [cfg, setCfg] = React.useState<any>(initialColumnsConfig);
  return (
    <div>
      <ColumnsPopover
        t={t}
        columnsConfig={cfg}
        fullLogSearchEnabled={fullLogSearchEnabled}
        onColumnsConfigChange={updater => setCfg((prev: any) => updater(prev))}
      />
      <div data-testid="cfg">{JSON.stringify(cfg)}</div>
    </div>
  );
}

describe('ColumnsPopover', () => {
  it('toggles visibility, reorders, and resets to defaults', () => {
    render(<Harness fullLogSearchEnabled={true} />);

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    screen.getByText('Show/hide and reorder columns');

    const userSwitch = screen.getByRole('switch', { name: 'User' });
    fireEvent.click(userSwitch);

    const afterToggle = JSON.parse(screen.getByTestId('cfg').textContent || '{}');
    expect(afterToggle.visibility.user).toBe(false);

    const moveDownButtons = screen.getAllByRole('button', { name: 'Move down' });
    fireEvent.click(moveDownButtons[0]!);

    const afterMove = JSON.parse(screen.getByTestId('cfg').textContent || '{}');
    expect(afterMove.order[0]).toBe('application');
    expect(afterMove.order[1]).toBe('user');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    const afterReset = JSON.parse(screen.getByTestId('cfg').textContent || '{}');
    expect(afterReset.order[0]).toBe('user');
    expect(afterReset.visibility.user).toBe(true);
    expect(afterReset.widths).toEqual({});
  });

  it('disables Match when full log search is disabled', () => {
    render(<Harness fullLogSearchEnabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));

    screen.getByText('Requires full log search');
    const matchSwitch = screen.getByRole('switch', { name: 'Match' });
    expect(matchSwitch).toBeDisabled();
  });
});

