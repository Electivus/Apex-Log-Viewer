import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { LogsApp } from '../main';

describe('Logs webview App', () => {
  function createVsCodeMock() {
    const posted: WebviewToExtensionMessage[] = [];
    const vscode: VsCodeWebviewApi<WebviewToExtensionMessage> = {
      postMessage: msg => {
        posted.push(msg);
      },
      getState: () => undefined,
      setState: () => {}
    };
    return { vscode, posted };
  }

  function sendMessage(bus: EventTarget, message: ExtensionToWebviewMessage) {
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  }

  it('responds to extension messages and exposes key actions', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogsApp vscode={vscode} messageBus={bus} />);

    expect(posted[0]).toEqual({ type: 'ready' });

    sendMessage(bus, { type: 'init', locale: 'pt-BR' });
    await screen.findByText('Atualizar');

    sendMessage(bus, { type: 'loading', value: true });
    await screen.findAllByText('Carregando…');

    sendMessage(bus, {
      type: 'orgs',
      data: [{ username: 'user@example.com', alias: 'Dev', isDefaultUsername: true }],
      selected: 'user@example.com'
    });

    sendMessage(bus, {
      type: 'logHead',
      logId: '07L000000000001AA',
      codeUnitStarted: 'AccountService.handle'
    });

    sendMessage(bus, { type: 'error', message: 'Falhou ao carregar' });
    await screen.findByText('Falhou ao carregar');

    const baseLogs = [
      {
        Id: '07L000000000001AA',
        StartTime: '2025-09-21T18:40:00.000Z',
        Operation: 'ExecuteAnonymous',
        Application: 'Developer Console',
        DurationMilliseconds: 125,
        Status: 'Success',
        Request: 'XYZ',
        LogLength: 2048,
        LogUser: { Name: 'Alice' }
      },
      {
        Id: '07L000000000002AA',
        StartTime: '2025-09-21T18:45:00.000Z',
        Operation: 'Test.run',
        Application: 'VS Code',
        DurationMilliseconds: 220,
        Status: 'Success',
        Request: 'ABC',
        LogLength: 512,
        LogUser: { Name: 'Bob' }
      }
    ];

    sendMessage(bus, { type: 'logs', data: baseLogs, hasMore: true });
    sendMessage(bus, { type: 'loading', value: false });
    await waitFor(() => {
      expect(screen.queryByText('Falhou ao carregar')).toBeNull();
    });

    await screen.findByText('ExecuteAnonymous');
    await screen.findByText('Test.run');

    sendMessage(bus, {
      type: 'appendLogs',
      data: [
        {
          Id: '07L000000000003AA',
          StartTime: '2025-09-21T18:55:00.000Z',
          Operation: 'BatchJob',
          Application: 'Salesforce',
          DurationMilliseconds: 75,
          Status: 'Success',
          Request: 'REQ',
          LogLength: 4096,
          LogUser: { Name: 'Alice' }
        }
      ],
      hasMore: false
    });

    await screen.findByText('BatchJob');

    const searchInput = screen.getByLabelText('Buscar logs…');
    fireEvent.change(searchInput, { target: { value: 'error' } });
    await waitFor(() => {
      expect(posted.some(msg => msg.type === 'searchQuery' && msg.value === 'error')).toBe(true);
    });
    sendMessage(bus, { type: 'searchMatches', query: 'error', logIds: ['07L000000000001AA'] });
    await screen.findByText('ExecuteAnonymous');

    const repeatedSearchCount = posted.filter(msg => msg.type === 'searchQuery' && msg.value === 'error').length;
    fireEvent.paste(searchInput);
    await waitFor(() => {
      const searchMessages = posted.filter(msg => msg.type === 'searchQuery' && msg.value === 'error');
      expect(searchMessages.length).toBeGreaterThan(repeatedSearchCount);
    });

    fireEvent.change(searchInput, { target: { value: 'Sem resultados' } });
    await waitFor(() => {
      expect(posted.some(msg => msg.type === 'searchQuery' && msg.value === 'Sem resultados')).toBe(true);
    });
    sendMessage(bus, { type: 'searchMatches', query: 'Sem resultados', logIds: [] });
    await screen.findByText('Nenhum log encontrado.');
    fireEvent.change(searchInput, { target: { value: '' } });
    sendMessage(bus, { type: 'searchMatches', query: '', logIds: [] });
    await screen.findByText('ExecuteAnonymous');

    const timeHeader = screen.getByRole('columnheader', { name: /Tempo/i });
    const timeButton = within(timeHeader).getByRole('button');
    fireEvent.click(timeButton);
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /Tempo/i }).getAttribute('aria-sort')).toBe('ascending');
    });

    const openButtons = await screen.findAllByRole('button', { name: 'Abrir' });
    fireEvent.click(openButtons[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Apex Replay' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));

    await waitFor(() => {
      const types = posted.map(m => m.type);
      expect(types[0]).toBe('ready');
      expect(types).toEqual(expect.arrayContaining(['openLog', 'replay', 'refresh']));
    });
  }, 10000);
});
