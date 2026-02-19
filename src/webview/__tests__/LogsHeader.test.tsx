import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { LogsHeader } from '../components/table/LogsHeader';

describe('LogsHeader', () => {
  it('renders columns and handles sort', () => {
    let sorted: string | undefined;
    const t = {
      columns: {
        user: 'User',
        application: 'Application',
        operation: 'Operation',
        time: 'Time',
        duration: 'Duration',
        status: 'Status',
        codeUnitStarted: 'Code Unit',
        size: 'Size',
        match: 'Match'
      }
    };
    render(
      <LogsHeader
        t={t}
        sortBy="user"
        sortDir="asc"
        onSort={key => {
          sorted = key;
        }}
        gridTemplate="1fr 1fr 96px"
        columns={['user', 'application']}
        onResizeColumn={() => {}}
        onClearColumnWidth={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Application' }));
    expect(sorted).toBe('application');
  });

  it('emits resize and clear events and renders non-sortable columns', () => {
    const t = {
      columns: {
        user: 'User',
        application: 'Application',
        match: 'Match',
        size: 'Size'
      }
    };
    const onResizeColumn = jest.fn();
    const onClearColumnWidth = jest.fn();

    render(
      <LogsHeader
        t={t}
        sortBy="user"
        sortDir="asc"
        onSort={() => {}}
        gridTemplate="1fr 1fr 1fr 96px"
        columns={['user', 'application', 'match']}
        onResizeColumn={onResizeColumn}
        onClearColumnWidth={onClearColumnWidth}
      />
    );

    expect(screen.getByText('Match')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Match' })).toBeNull();

    const applicationHeader = screen.getByRole('columnheader', { name: /Application/i }) as HTMLElement;
    (applicationHeader as any).getBoundingClientRect = () => ({
      width: 200,
      height: 20,
      top: 0,
      left: 0,
      right: 200,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    const handle = screen.getByRole('separator', { name: 'Resize Application' });
    fireEvent.pointerDown(handle, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(onResizeColumn).toHaveBeenCalledWith('application', 250, { persist: false });
    expect(onResizeColumn).toHaveBeenCalledWith('application', 250, { persist: true });

    fireEvent.doubleClick(handle);
    expect(onClearColumnWidth).toHaveBeenCalledWith('application');
  });
});
