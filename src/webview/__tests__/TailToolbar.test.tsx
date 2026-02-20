import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { TailToolbar } from '../components/tail/TailToolbar';
import { getMessages } from '../i18n';
import type { OrgItem } from '../../shared/types';

const t = getMessages('en');
const orgs: OrgItem[] = [{ username: 'user@example.com', alias: 'Primary', isDefaultUsername: true }];

function renderWithNativeSelect(element: React.ReactElement) {
  const docRef = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
  const originalDocumentFragment = docRef.DocumentFragment;
  docRef.DocumentFragment = undefined;
  const result = render(element);
  docRef.DocumentFragment = originalDocumentFragment;
  const baseRerender = result.rerender;
  return {
    ...result,
    rerender: (next: React.ReactElement) => {
      const snapshot = docRef.DocumentFragment;
      docRef.DocumentFragment = undefined;
      try {
        baseRerender(next);
      } finally {
        docRef.DocumentFragment = snapshot;
      }
    }
  };
}

describe('TailToolbar webview component', () => {
  it('starts and stops tailing based on running state', () => {
    let starts = 0;
    let stops = 0;

    const { rerender } = renderWithNativeSelect(
      <TailToolbar
        running={false}
        onStart={() => {
          starts++;
        }}
        onStop={() => {
          stops++;
        }}
        onClear={() => {}}
        onOpenSelected={() => {}}
        onReplaySelected={() => {}}
        onOpenDebugFlags={() => {}}
        actionsEnabled={false}
        disabled={false}
        orgs={orgs}
        selectedOrg="user@example.com"
        onSelectOrg={() => {}}
        query=""
        onQueryChange={() => {}}
        onlyUserDebug={false}
        onToggleOnlyUserDebug={() => {}}
        colorize={false}
        onToggleColorize={() => {}}
        debugLevels={['LevelA', 'LevelB']}
        debugLevel="LevelA"
        onDebugLevelChange={() => {}}
        autoScroll={false}
        onToggleAutoScroll={() => {}}
        t={t}
      />
    );

    const startButton = screen.getByRole('button', { name: 'Start' });
    fireEvent.click(startButton);
    expect(starts).toBe(1);

    rerender(
      <TailToolbar
        running
        onStart={() => {
          starts++;
        }}
        onStop={() => {
          stops++;
        }}
        onClear={() => {}}
        onOpenSelected={() => {}}
        onReplaySelected={() => {}}
        onOpenDebugFlags={() => {}}
        actionsEnabled
        disabled={false}
        orgs={orgs}
        selectedOrg="user@example.com"
        onSelectOrg={() => {}}
        query=""
        onQueryChange={() => {}}
        onlyUserDebug={false}
        onToggleOnlyUserDebug={() => {}}
        colorize={false}
        onToggleColorize={() => {}}
        debugLevels={['LevelA', 'LevelB']}
        debugLevel="LevelA"
        onDebugLevelChange={() => {}}
        autoScroll={false}
        onToggleAutoScroll={() => {}}
        t={t}
      />
    );

    const stopButton = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stopButton);
    expect(stops).toBe(1);
  });

  it('disables actions while busy and surfaces error copy', () => {
    const openCalls: string[] = [];

    renderWithNativeSelect(
      <TailToolbar
        running={false}
        onStart={() => {}}
        onStop={() => {}}
        onClear={() => {}}
        onOpenSelected={() => openCalls.push('open')}
        onReplaySelected={() => openCalls.push('replay')}
        onOpenDebugFlags={() => openCalls.push('debugFlags')}
        actionsEnabled
        disabled
        orgs={orgs}
        selectedOrg="user@example.com"
        onSelectOrg={() => {}}
        query="needle"
        onQueryChange={() => {}}
        onlyUserDebug
        onToggleOnlyUserDebug={() => {}}
        colorize
        onToggleColorize={() => {}}
        debugLevels={['LevelA']}
        debugLevel=""
        onDebugLevelChange={() => {}}
        autoScroll
        onToggleAutoScroll={() => {}}
        error="Connection lost"
        t={t}
      />
    );

    screen.getByText('Connection lost');

    const openButton = screen.getByRole('button', { name: 'Open Log' });
    expect(openButton).toBeDisabled();
    const loader = openButton.querySelector('.animate-spin');
    expect(loader).not.toBeNull();

    fireEvent.click(openButton);
    expect(openCalls).toEqual([]);
  });

  it('propagates control changes for filters, switches and inputs', () => {
    const toggles: Array<{ type: string; value: boolean }> = [];
    const debugChanges: string[] = [];
    const queryChanges: string[] = [];

    renderWithNativeSelect(
      <TailToolbar
        running={false}
        onStart={() => {}}
        onStop={() => {}}
        onClear={() => {}}
        onOpenSelected={() => {}}
        onReplaySelected={() => {}}
        onOpenDebugFlags={() => {}}
        actionsEnabled={true}
        disabled={false}
        orgs={orgs}
        selectedOrg="user@example.com"
        onSelectOrg={() => {}}
        query=""
        onQueryChange={value => {
          queryChanges.push(value);
        }}
        onlyUserDebug={false}
        onToggleOnlyUserDebug={value => {
          toggles.push({ type: 'debug', value });
        }}
        colorize={false}
        onToggleColorize={value => {
          toggles.push({ type: 'color', value });
        }}
        debugLevels={['LevelA', 'LevelB']}
        debugLevel=""
        onDebugLevelChange={value => {
          debugChanges.push(value);
        }}
        autoScroll={false}
        onToggleAutoScroll={value => {
          toggles.push({ type: 'auto', value });
        }}
        t={t}
      />
    );

    const searchInput = screen.getByLabelText('Search live logs…') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'filter' } });
    expect(queryChanges).toEqual(['filter']);

    const debugLevelSelect = screen.getByLabelText('Debug level') as HTMLSelectElement;
    fireEvent.change(debugLevelSelect, { target: { value: 'LevelB' } });
    expect(debugChanges).toEqual(['LevelB']);

    fireEvent.click(screen.getByLabelText('Debug Only'));
    fireEvent.click(screen.getByLabelText('Color'));
    fireEvent.click(screen.getByLabelText('Auto-scroll'));

    expect(toggles).toEqual([
      { type: 'debug', value: true },
      { type: 'color', value: true },
      { type: 'auto', value: true }
    ]);
  });

  it('opens debug flags from tail toolbar', () => {
    const calls: string[] = [];
    renderWithNativeSelect(
      <TailToolbar
        running={false}
        onStart={() => {}}
        onStop={() => {}}
        onClear={() => {}}
        onOpenSelected={() => {}}
        onReplaySelected={() => {}}
        onOpenDebugFlags={() => calls.push('open')}
        actionsEnabled={false}
        disabled={false}
        orgs={orgs}
        selectedOrg="user@example.com"
        onSelectOrg={() => {}}
        query=""
        onQueryChange={() => {}}
        onlyUserDebug={false}
        onToggleOnlyUserDebug={() => {}}
        colorize={false}
        onToggleColorize={() => {}}
        debugLevels={['LevelA']}
        debugLevel="LevelA"
        onDebugLevelChange={() => {}}
        autoScroll={false}
        onToggleAutoScroll={() => {}}
        t={t}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Debug Flags' }));
    expect(calls).toEqual(['open']);
  });
});
