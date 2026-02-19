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
      expect(posted.some(msg => msg.type === 'debugFlagsSelectUser' && msg.userId === '005000000000001AAA')).toBe(true);
    });

    sendMessage(bus, {
      type: 'debugFlagsUserStatus',
      userId: '005000000000001AAA',
      status: {
        traceFlagId: '7tf000000000001AAA',
        debugLevelName: 'ALV_E2E',
        startDate: '2026-02-19T17:00:00.000Z',
        expirationDate: '2026-02-19T18:00:00.000Z',
        isActive: true
      }
    });
    await screen.findByTestId('debug-flags-status-level');

    const ttl = screen.getByTestId('debug-flags-ttl') as HTMLInputElement;
    fireEvent.change(ttl, { target: { value: '45' } });

    fireEvent.click(screen.getByTestId('debug-flags-apply'));
    await waitFor(() => {
      expect(
        posted.some(
          msg =>
            msg.type === 'debugFlagsApply' &&
            msg.userId === '005000000000001AAA' &&
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
      expect(posted.some(msg => msg.type === 'debugFlagsRemove' && msg.userId === '005000000000001AAA')).toBe(true);
    });
  });

  it('sends debounced user search queries', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<DebugFlagsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'debugFlagsInit', locale: 'en', defaultTtlMinutes: 30 });
    const search = screen.getByTestId('debug-flags-user-search');
    fireEvent.change(search, { target: { value: 'ada' } });
    await waitFor(
      () => {
        expect(posted.some(msg => msg.type === 'debugFlagsSearchUsers' && msg.query === 'ada')).toBe(true);
      },
      { timeout: 1000 }
    );
  });
});
