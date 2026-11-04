import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DebugFlagsFromWebviewMessage, DebugFlagsToWebviewMessage } from '@alv/protocol/debugFlagsMessages';
import type { TraceFlagTarget, TraceFlagTargetStatus } from '@alv/protocol/debugFlagsTypes';
import { DEBUG_LEVEL_PRESETS } from '@alv/protocol/debugLevelPresets';
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
            msg.target.userId === '005000000000001AAA' &&
            msg.logType === 'DEVELOPER_LOG'
        )
      ).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsTargetStatus',
      target: { type: 'user', userId: '005000000000001AAA' },
      status: {
        target: { type: 'user', userId: '005000000000001AAA' },
        logType: 'DEVELOPER_LOG',
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
            msg.logType === 'DEVELOPER_LOG' &&
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

  it('preselects the Maximum Trace preset and applies every category at its highest level', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });
    sendMessage(bus, {
      type: 'debugFlagsManagerData',
      records: [],
      presets: DEBUG_LEVEL_PRESETS
    });
    await screen.findByTestId('debug-level-manager');

    const presetSelect = screen.getByTestId('debug-level-preset-select') as HTMLSelectElement;
    expect(presetSelect.value).toBe('maximum-trace');
    expect(screen.getByTestId('debug-level-preset-description').textContent).toBe(
      'Every category at its highest documented level. Expect large logs.'
    );

    fireEvent.click(screen.getByTestId('debug-level-apply-preset'));

    expect((screen.getByTestId('debug-level-draft-developer-name') as HTMLInputElement).value).toBe(
      'ALV_MAXIMUM_TRACE'
    );
    expect((screen.getByTestId('debug-level-draft-master-label') as HTMLInputElement).value).toBe('ALV Maximum Trace');
    const fieldValue = (key: string) => (screen.getByTestId(`debug-level-field-${key}`) as HTMLSelectElement).value;
    expect({
      workflow: fieldValue('workflow'),
      validation: fieldValue('validation'),
      callout: fieldValue('callout'),
      apexCode: fieldValue('apexCode'),
      apexProfiling: fieldValue('apexProfiling'),
      visualforce: fieldValue('visualforce'),
      system: fieldValue('system'),
      database: fieldValue('database'),
      wave: fieldValue('wave'),
      nba: fieldValue('nba'),
      dataAccess: fieldValue('dataAccess')
    }).toEqual({
      workflow: 'FINER',
      validation: 'INFO',
      callout: 'FINER',
      apexCode: 'FINEST',
      apexProfiling: 'FINEST',
      visualforce: 'FINER',
      system: 'FINE',
      database: 'FINEST',
      wave: 'FINEST',
      nba: 'FINE',
      dataAccess: 'FINER'
    });

    fireEvent.change(presetSelect, { target: { value: 'developer-focus' } });
    expect(presetSelect.value).toBe('developer-focus');
    expect(screen.getByTestId('debug-level-preset-description').textContent).toBe(
      'Balanced defaults for Apex execution and general debugging.'
    );
    fireEvent.change(presetSelect, { target: { value: '' } });
    expect(screen.queryByTestId('debug-level-preset-description')).toBeNull();
    fireEvent.click(screen.getByTestId('debug-level-manager-new'));
    expect(presetSelect.value).toBe('maximum-trace');
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
        logType: 'DEVELOPER_LOG',
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
        logType: 'DEVELOPER_LOG',
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

  it('switches the trace flag log type, re-reads the selected target and acts on the chosen type', async () => {
    const globalDoc = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
    const originalDocumentFragment = globalDoc.DocumentFragment;
    // Native selects keep the log type select operable in jsdom.
    globalDoc.DocumentFragment = undefined;
    try {
      const { vscode, posted } = createVsCodeMock();
      const lastPosted = <T extends DebugFlagsFromWebviewMessage['type']>(type: T) =>
        posted.filter(msg => msg.type === type).pop();
      const bus = new EventTarget();
      render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

      sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
      sendMessage(bus, {
        type: 'debugFlagsOrgs',
        data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
        selected: 'user@example.com'
      });
      sendMessage(bus, { type: 'debugFlagsDebugLevels', data: ['ALV_E2E'], active: 'ALV_E2E' });
      sendMessage(bus, {
        type: 'debugFlagsUsers',
        query: '',
        data: [{ id: '005000000000001AAA', name: 'Ada Lovelace', username: 'ada@example.com', active: true }]
      });

      const target = { type: 'user', userId: '005000000000001AAA' } as const;
      const statusOf = (logType: 'DEVELOPER_LOG' | 'USER_DEBUG', debugLevelName: string) => ({
        type: 'debugFlagsTargetStatus' as const,
        target,
        status: {
          target,
          logType,
          targetLabel: 'Ada Lovelace',
          targetAvailable: true,
          traceFlagId: '7tf000000000001AAA',
          debugLevelName,
          startDate: '2026-02-19T17:00:00.000Z',
          expirationDate: '2026-02-19T18:00:00.000Z',
          isActive: true
        }
      });

      fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));
      expect(lastPosted('debugFlagsSelectTarget')).toEqual({
        type: 'debugFlagsSelectTarget',
        target,
        logType: 'DEVELOPER_LOG'
      });
      sendMessage(bus, statusOf('DEVELOPER_LOG', 'ALV_DEVELOPER'));
      expect(screen.getByTestId('debug-flags-status-level')).toHaveTextContent('ALV_DEVELOPER');

      const logTypeSelect = screen.getByTestId('debug-flags-log-type') as HTMLSelectElement;
      expect(Array.from(logTypeSelect.options).map(option => option.textContent)).toEqual([
        'Developer log (DEVELOPER_LOG)',
        'User debug (USER_DEBUG)'
      ]);
      fireEvent.change(logTypeSelect, { target: { value: 'USER_DEBUG' } });

      expect(lastPosted('debugFlagsSelectTarget')).toEqual({
        type: 'debugFlagsSelectTarget',
        target,
        logType: 'USER_DEBUG'
      });
      expect(screen.getByText('No active USER_DEBUG trace flag for this target.')).toBeInTheDocument();

      sendMessage(bus, statusOf('DEVELOPER_LOG', 'ALV_DEVELOPER'));
      expect(screen.queryByTestId('debug-flags-status-level')).toBeNull();
      sendMessage(bus, statusOf('USER_DEBUG', 'ALV_USER_DEBUG'));
      expect(screen.getByTestId('debug-flags-status-level')).toHaveTextContent('ALV_USER_DEBUG');

      fireEvent.click(screen.getByTestId('debug-flags-apply'));
      expect(lastPosted('debugFlagsApply')).toEqual({
        type: 'debugFlagsApply',
        target,
        logType: 'USER_DEBUG',
        debugLevelName: 'ALV_E2E',
        ttlMinutes: 30
      });
      fireEvent.click(screen.getByTestId('debug-flags-remove'));
      expect(lastPosted('debugFlagsRemove')).toEqual({ type: 'debugFlagsRemove', target, logType: 'USER_DEBUG' });
    } finally {
      globalDoc.DocumentFragment = originalDocumentFragment;
    }
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
        logType: 'DEVELOPER_LOG',
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

  it('ignores stale user search results that do not match the current query', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    sendMessage(bus, {
      type: 'debugFlagsOrgs',
      data: [{ username: 'user@example.com', alias: 'Main', isDefaultUsername: true }],
      selected: 'user@example.com'
    });

    const search = screen.getByTestId('debug-flags-user-search');
    fireEvent.change(search, { target: { value: 'ada' } });

    sendMessage(bus, {
      type: 'debugFlagsUsers',
      query: 'ada',
      data: [
        {
          id: '005000000000001AAA',
          name: 'Ada Lovelace',
          username: 'ada@example.com',
          active: true
        }
      ]
    });
    await screen.findByTestId('debug-flags-user-row-005000000000001AAA');

    sendMessage(bus, {
      type: 'debugFlagsUsers',
      query: '',
      data: []
    });

    expect(screen.getByTestId('debug-flags-user-row-005000000000001AAA')).toBeTruthy();
    expect(screen.queryByText('No active users found for this query.')).toBeNull();
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

  describe('other log type note', () => {
    const globalDoc = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
    const originalDocumentFragment = globalDoc.DocumentFragment;
    const user = { type: 'user', userId: '005000000000001AAA' } as const;
    const activeDeveloperLog = {
      logType: 'DEVELOPER_LOG',
      isActive: true,
      activeTargetCount: 1,
      expirationDate: '2098-06-01T12:00:00.000Z'
    } as const;
    const activeUserDebug = {
      logType: 'USER_DEBUG',
      isActive: true,
      activeTargetCount: 1,
      expirationDate: '2099-02-19T18:00:00.000Z'
    } as const;

    beforeEach(() => {
      // Native selects keep the log type select operable in jsdom.
      globalDoc.DocumentFragment = undefined;
    });

    afterEach(() => {
      globalDoc.DocumentFragment = originalDocumentFragment;
    });

    function renderPanel() {
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
      sendMessage(bus, {
        type: 'debugFlagsUsers',
        query: '',
        data: [{ id: user.userId, name: 'Ada Lovelace', username: 'ada@example.com', active: true }]
      });
      return { bus, posted };
    }

    function statusFor(
      target: TraceFlagTarget,
      status: Omit<TraceFlagTargetStatus, 'target' | 'targetLabel' | 'targetAvailable'>
    ): DebugFlagsToWebviewMessage {
      return {
        type: 'debugFlagsTargetStatus',
        target,
        status: { target, targetLabel: 'Ada Lovelace', targetAvailable: true, ...status }
      };
    }

    const selectLogType = (value: 'DEVELOPER_LOG' | 'USER_DEBUG') =>
      fireEvent.change(screen.getByTestId('debug-flags-log-type'), { target: { value } });
    const note = () => screen.queryByTestId('debug-flags-other-log-type-note');

    it('warns that an active DEVELOPER_LOG flag sets the level of a USER_DEBUG target', () => {
      const { bus } = renderPanel();
      fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));
      selectLogType('USER_DEBUG');

      sendMessage(
        bus,
        statusFor(user, {
          logType: 'USER_DEBUG',
          isActive: true,
          traceFlagId: '7tf000000000002AAA',
          debugLevelName: 'ALV_USER_DEBUG',
          expirationDate: '2099-02-19T18:00:00.000Z',
          otherLogType: activeDeveloperLog
        })
      );

      expect(note()).toHaveTextContent('A DEVELOPER_LOG trace flag is also active on this target until');
      expect(note()).toHaveTextContent(/2098.*so this USER_DEBUG level does not apply until then\.$/);
      expect(screen.queryByTestId('debug-flags-other-log-type-switch')).toBeNull();
    });

    it('counts the matched special targets that carry the overriding DEVELOPER_LOG flag', () => {
      const { bus } = renderPanel();
      const platformIntegration = { type: 'platformIntegration' } as const;
      fireEvent.click(screen.getByTestId('debug-flags-special-target-platform-integration'));
      selectLogType('USER_DEBUG');

      sendMessage(
        bus,
        statusFor(platformIntegration, {
          logType: 'USER_DEBUG',
          isActive: false,
          resolvedTargetCount: 2,
          activeTargetCount: 0,
          otherLogType: activeDeveloperLog
        })
      );

      expect(note()).toHaveTextContent('A DEVELOPER_LOG trace flag is also active on 1 of 2 matched targets until');
    });

    it('points a DEVELOPER_LOG target without a flag to its active USER_DEBUG flag and switches to it', () => {
      const { bus, posted } = renderPanel();
      fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));

      sendMessage(bus, statusFor(user, { logType: 'DEVELOPER_LOG', isActive: false, otherLogType: activeUserDebug }));

      expect(note()).toHaveTextContent(/^A USER_DEBUG trace flag is active on this target until .*2099.*\./);
      fireEvent.click(screen.getByTestId('debug-flags-other-log-type-switch'));

      expect(posted.filter(msg => msg.type === 'debugFlagsSelectTarget').pop()).toEqual({
        type: 'debugFlagsSelectTarget',
        target: user,
        logType: 'USER_DEBUG'
      });
      expect(screen.getByTestId('debug-flags-log-type')).toHaveValue('USER_DEBUG');
      expect(note()).toBeNull();
    });

    it('shows no note when the other type has no active flag or the DEVELOPER_LOG flag is active', () => {
      const { bus } = renderPanel();
      fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));

      sendMessage(
        bus,
        statusFor(user, {
          logType: 'DEVELOPER_LOG',
          isActive: false,
          otherLogType: { logType: 'USER_DEBUG', isActive: false, activeTargetCount: 0 }
        })
      );
      expect(screen.getByText('No active DEVELOPER_LOG trace flag for this target.')).toBeInTheDocument();
      expect(note()).toBeNull();

      sendMessage(
        bus,
        statusFor(user, {
          logType: 'DEVELOPER_LOG',
          isActive: true,
          traceFlagId: '7tf000000000001AAA',
          debugLevelName: 'ALV_DEVELOPER',
          otherLogType: activeUserDebug
        })
      );
      expect(screen.getByTestId('debug-flags-status-level')).toHaveTextContent('ALV_DEVELOPER');
      expect(note()).toBeNull();

      selectLogType('USER_DEBUG');
      sendMessage(
        bus,
        statusFor(user, {
          logType: 'USER_DEBUG',
          isActive: true,
          traceFlagId: '7tf000000000002AAA',
          debugLevelName: 'ALV_USER_DEBUG',
          otherLogType: { logType: 'DEVELOPER_LOG', isActive: false, activeTargetCount: 0 }
        })
      );
      expect(screen.getByTestId('debug-flags-status-level')).toHaveTextContent('ALV_USER_DEBUG');
      expect(note()).toBeNull();
    });

    it('ignores the other log type of a stale status for the previous log type', () => {
      const { bus } = renderPanel();
      fireEvent.click(screen.getByTestId('debug-flags-user-row-005000000000001AAA'));
      selectLogType('USER_DEBUG');

      sendMessage(bus, statusFor(user, { logType: 'DEVELOPER_LOG', isActive: false, otherLogType: activeUserDebug }));

      expect(screen.getByText('No active USER_DEBUG trace flag for this target.')).toBeInTheDocument();
      expect(note()).toBeNull();
      expect(screen.queryByTestId('debug-flags-other-log-type-switch')).toBeNull();

      sendMessage(bus, statusFor(user, { logType: 'USER_DEBUG', isActive: false, otherLogType: activeDeveloperLog }));
      expect(note()).toHaveTextContent('A DEVELOPER_LOG trace flag is also active on this target until');
    });
  });
});
