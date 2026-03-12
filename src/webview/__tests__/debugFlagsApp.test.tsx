import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '../../shared/debugFlagsMessages';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { DebugFlagsApp } from '../debugFlags';

describe('DebugFlags webview App', () => {
  function createVsCodeMock() {
    const posted: DebugFlagsFromWebviewMessage[] = [];
    const vscode: VsCodeWebviewApi<DebugFlagsFromWebviewMessage> = {
      postMessage: msg => {
        posted.push(msg);
      },
      getState: () => undefined,
      setState: () => {}
    };
    return { vscode, posted };
  }

  function sendMessage(bus: EventTarget, message: DebugFlagsToWebviewMessage) {
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  }

  it('loads data, configures flags and removes flags', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    expect(posted[0]).toEqual({ type: 'debugFlagsReady' });

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'pt-BR', defaultTtlMinutes: 30 });
    await screen.findByText('Apex Debug Flags');

    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });
    sendMessage(bus, { type: 'debugFlagsDebugLevels', data: ['ALV_E2E', 'DEVELOPER_LOG'], active: 'ALV_E2E' });
    sendMessage(bus, {
      type: 'debugFlagsUsers',
      query: '',
      data: [
        {
          id: '005000000000001AAA',
          name: 'Ada Lovelace',
          username: 'ada@example.com',
          active: true
        }
      ]
    });

    fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsSelectTarget' &&
            msg.target.type === 'user' &&
            msg.target.userId === '005000000000001AAA'
        )
      ).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsTargetStatus',
      target: { type: 'user', userId: '005000000000001AAA' },
      status: {
        target: { type: 'user', userId: '005000000000001AAA' },
        targetLabel: 'Ada Lovelace',
        targetAvailable: true,
        traceFlagId: '7tf000000000001AAA',
        debugLevelName: 'ALV_E2E',
        startDate: '2026-02-19T17:00:00.000Z',
        expirationDate: '2026-02-19T18:00:00.000Z',
        isActive: true
      }
    });
    sendMessage(bus, {
      type: 'debugFlagsManagerData',
      records: [
        {
          id: '7dl000000000001AAA',
          developerName: 'ALV_E2E',
          masterLabel: 'ALV E2E',
          language: 'en_US',
          workflow: 'ERROR',
          validation: 'INFO',
          callout: 'WARN',
          apexCode: 'DEBUG',
          apexProfiling: 'INFO',
          visualforce: 'WARN',
          system: 'DEBUG',
          database: 'FINE',
          wave: 'INFO',
          nba: 'WARN',
          dataAccess: 'INFO'
        }
      ],
      presets: [
        {
          id: 'integration',
          label: 'Integration Troubleshooting',
          description: 'Useful defaults for callouts and integration diagnosis.',
          record: {
            developerName: 'ALV_INTEGRATION',
            masterLabel: 'ALV Integration',
            language: 'en_US',
            workflow: 'INFO',
            validation: 'WARN',
            callout: 'DEBUG',
            apexCode: 'DEBUG',
            apexProfiling: 'INFO',
            visualforce: 'WARN',
            system: 'DEBUG',
            database: 'INFO',
            wave: 'INFO',
            nba: 'INFO',
            dataAccess: 'WARN'
          }
        }
      ],
      selectedId: '7dl000000000001AAA'
    });
    await screen.findByTestId('debug-flags-status-level');
    await screen.findByTestId('debug-level-manager');

    const managerDeveloperName = screen.getByTestId('debug-level-draft-developer-name') as HTMLInputElement;
    expect(managerDeveloperName.value).toBe('ALV_E2E');

    fireEvent.change(managerDeveloperName, { target: { value: 'ALV_CHANGED' } });
    expect(managerDeveloperName.value).toBe('ALV_CHANGED');
    fireEvent.click(screen.getByTestId('debug-level-reset'));
    expect(managerDeveloperName.value).toBe('ALV_E2E');

    fireEvent.click(screen.getByTestId('debug-level-delete'));
    expect(screen.getByTestId('debug-level-delete-confirmation')).toBeTruthy();
    expect(
      posted.some(msg => msg.type === 'debugFlagsManagerDelete' && msg.debugLevelId === '7dl000000000001AAA')
    ).toBe(false);

    fireEvent.click(screen.getByTestId('debug-level-delete-confirm'));
    await waitFor(() => {
      expect(
        posted.some(msg => msg.type === 'debugFlagsManagerDelete' && msg.debugLevelId === '7dl000000000001AAA')
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId('debug-level-manager-new'));
    expect(managerDeveloperName.value).toBe('');

    fireEvent.change(screen.getByTestId('debug-level-preset-select'), {
      target: { value: 'integration' }
    });
    fireEvent.click(screen.getByTestId('debug-level-apply-preset'));
    expect(managerDeveloperName.value).toBe('ALV_INTEGRATION');

    fireEvent.change(managerDeveloperName, { target: { value: 'ALV_INTEGRATION_CUSTOM' } });
    fireEvent.change(screen.getByTestId('debug-level-field-wave'), {
      target: { value: 'DEBUG' }
    });
    fireEvent.click(screen.getByTestId('debug-level-save'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsManagerSave' &&
            msg.draft.developerName === 'ALV_INTEGRATION_CUSTOM' &&
            msg.draft.wave === 'DEBUG'
        )
      ).toBe(true);
    });

    const ttl = screen.getByTestId('debug-flags-ttl') as HTMLInputElement;
    fireEvent.change(ttl, { target: { value: '45' } });

    fireEvent.click(screen.getByTestId('debug-flags-apply'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsApply' &&
            msg.target.type === 'user' &&
            msg.target.userId === '005000000000001AAA' &&
            msg.debugLevelName === 'ALV_E2E' &&
            msg.ttlMinutes === 45
        )
      ).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsNotice',
      tone: 'success',
      message: 'Debug flag updated successfully.'
    });
    await screen.findByTestId('debug-flags-notice');

    fireEvent.click(screen.getByTestId('debug-flags-remove'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsRemove' && msg.target.type === 'user' && msg.target.userId === '005000000000001AAA'
        )
      ).toBe(true);
    });
  });

  it('supports aggregated special-target status and disables actions when a special target is unavailable', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });
    sendMessage(bus, { type: 'debugFlagsDebugLevels', data: ['ALV_E2E'], active: 'ALV_E2E' });

    fireEvent.click(screen.getByTestId('debug-flags-special-target-automated-process'));
    await waitFor(() => {
      expect(posted.some(msg => msg.type === 'debugFlagsSelectTarget' && msg.target.type === 'automatedProcess')).toBe(
        true
      );
    });

    sendMessage(bus, {
      type: 'debugFlagsTargetStatus',
      target: { type: 'automatedProcess' },
      status: {
        target: { type: 'automatedProcess' },
        targetLabel: 'Automated Process',
        targetAvailable: false,
        unavailableReason: 'Automated Process is not available in this org.',
        isActive: false
      }
    });

    await screen.findByTestId('debug-flags-target-unavailable');
    expect(screen.getByTestId('debug-flags-apply')).toBeDisabled();
    expect(screen.getByTestId('debug-flags-remove')).toBeDisabled();

    fireEvent.click(screen.getByTestId('debug-flags-special-target-platform-integration'));
    await waitFor(() => {
      expect(
        posted.some(msg => msg.type === 'debugFlagsSelectTarget' && msg.target.type === 'platformIntegration')
      ).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsTargetStatus',
      target: { type: 'platformIntegration' },
      status: {
        target: { type: 'platformIntegration' },
        targetLabel: 'Platform Integration',
        targetAvailable: true,
        resolvedTargetCount: 2,
        activeTargetCount: 1,
        debugLevelMixed: true,
        isActive: true
      }
    });

    await screen.findByTestId('debug-flags-status-resolved-count');
    expect(screen.getByTestId('debug-flags-status-resolved-count')).toHaveTextContent('2');
    expect(screen.getByTestId('debug-flags-status-active-count')).toHaveTextContent('1/2');
    expect(screen.getByTestId('debug-flags-status-level')).toHaveTextContent('Mixed');

    fireEvent.click(screen.getByTestId('debug-flags-apply'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsApply' &&
            msg.target.type === 'platformIntegration' &&
            msg.debugLevelName === 'ALV_E2E' &&
            msg.ttlMinutes === 30
        )
      ).toBe(true);
    });

    fireEvent.click(screen.getByTestId('debug-flags-remove'));
    await waitFor(() => {
      expect(posted.some(msg => msg.type === 'debugFlagsRemove' && msg.target.type === 'platformIntegration')).toBe(
        true
      );
    });
  });

  it('clears the selected target status when the extension switches orgs', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [
        { username: 'user@example.com', alias: 'Main', isDefaultUsername: true },
        { username: 'other@example.com', alias: 'Other', isDefaultUsername: false }
      ],
      selected: 'user@example.com'
    });
    sendMessage(bus, { type: 'debugFlagsDebugLevels', data: ['ALV_E2E'], active: 'ALV_E2E' });
    sendMessage(bus, {
      type: 'debugFlagsUsers',
      query: '',
      data: [
        {
          id: '005000000000001AAA',
          name: 'Ada Lovelace',
          username: 'ada@example.com',
          active: true
        }
      ]
    });

    fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsSelectTarget' &&
            msg.target.type === 'user' &&
            msg.target.userId === '005000000000001AAA'
        )
      ).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsTargetStatus',
      target: { type: 'user', userId: '005000000000001AAA' },
      status: {
        target: { type: 'user', userId: '005000000000001AAA' },
        targetLabel: 'Ada Lovelace',
        targetAvailable: true,
        traceFlagId: '7tf000000000001AAA',
        debugLevelName: 'ALV_E2E',
        startDate: '2026-02-19T17:00:00.000Z',
        expirationDate: '2026-02-19T18:00:00.000Z',
        isActive: true
      }
    });

    await screen.findByTestId('debug-flags-status-level');
    expect(screen.getByTestId('debug-flags-selected-target-label')).toHaveTextContent('Ada Lovelace');

    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [
        { username: 'user@example.com', alias: 'Main', isDefaultUsername: true },
        { username: 'other@example.com', alias: 'Other', isDefaultUsername: false }
      ],
      selected: 'other@example.com'
    });

    await screen.findByText('Select a special target or an active user to inspect and configure debug flags.');
    expect(screen.queryByTestId('debug-flags-status-level')).toBeNull();
    expect(screen.queryByTestId('debug-flags-selected-target-label')).toBeNull();
    expect(screen.queryByTestId('debug-flags-user-row-005000000000001AAA')).toBeNull();
  });

  it('sends debounced user search queries', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    expect(posted.some(msg => msg.type === 'debugFlagsSearchUsers')).toBe(false);

    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });
    const search = screen.getByTestId('debug-flags-user-search');
    fireEvent.change(search, { target: { value: 'ada' } });
    await waitFor(
      () => {
        expect(posted.some(msg => msg.type === 'debugFlagsSearchUsers' && msg.query === 'ada')).toBe(true);
      },
      { timeout: 1000 }
    );
  });

  it('triggers clear logs actions from menu', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete my logs' }));
    expect(posted.some(msg => msg.type === 'debugFlagsClearLogs' && msg.scope === 'mine')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Clear logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all org logs' }));
    expect(posted.some(msg => msg.type === 'debugFlagsClearLogs' && msg.scope === 'all')).toBe(true);
  });
});
