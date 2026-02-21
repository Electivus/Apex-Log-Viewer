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

    sendMessage(bus, { type: 'init', locale: 'pt-BR', fullLogSearchEnabled: true });
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

    sendMessage(bus, {
      type: 'warning',
      message: 'sourceApiVersion 66.0 > org max 64.0; falling back to 64.0'
    });
    await screen.findByText('Aviso:');
    await screen.findByText('sourceApiVersion 66.0 > org max 64.0; falling back to 64.0');

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
    sendMessage(bus, {
      type: 'searchMatches',
      query: 'error',
      logIds: ['07L000000000001AA'],
      snippets: {
        '07L000000000001AA': {
          text: '...error line in body...',
          ranges: [[3, 8]]
        }
      },
      pendingLogIds: []
    });
    await screen.findByText('ExecuteAnonymous');
    const highlight = await screen.findByText('error', { selector: 'mark' });
    expect(highlight).toBeInTheDocument();

    const repeatedSearchCount = posted.filter(msg => msg.type === 'searchQuery' && msg.value === 'error').length;
    sendMessage(bus, { type: 'searchStatus', state: 'loading' });
    await screen.findByText('Preparando resultados da busca…');
    sendMessage(bus, { type: 'searchStatus', state: 'idle' });
    await waitFor(() => {
      expect(screen.queryByText('Preparando resultados da busca…')).toBeNull();
    });
    sendMessage(bus, {
      type: 'searchMatches',
      query: 'error',
      logIds: [],
      snippets: {},
      pendingLogIds: ['07L000000000001AA', '07L000000000002AA']
    });
    await screen.findByText('Aguardando o download de 2 logs…');

    fireEvent.paste(searchInput);
    await waitFor(() => {
      const searchMessages = posted.filter(msg => msg.type === 'searchQuery' && msg.value === 'error');
      expect(searchMessages.length).toBeGreaterThan(repeatedSearchCount);
    });

    fireEvent.change(searchInput, { target: { value: 'Sem resultados' } });
    await waitFor(() => {
      expect(posted.some(msg => msg.type === 'searchQuery' && msg.value === 'Sem resultados')).toBe(true);
    });
    sendMessage(bus, { type: 'searchMatches', query: 'Sem resultados', logIds: [], snippets: {} });
    await screen.findByText('Nenhum log encontrado.');
    fireEvent.change(searchInput, { target: { value: '' } });
    sendMessage(bus, { type: 'searchMatches', query: '', logIds: [], snippets: {} });
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
    fireEvent.click(screen.getByRole('button', { name: 'Debug Flags' }));
    fireEvent.click(screen.getByRole('button', { name: 'Baixar todos os logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));

    await waitFor(() => {
      const types = posted.map(m => m.type);
      expect(types[0]).toBe('ready');
      expect(types).toEqual(expect.arrayContaining(['openLog', 'replay', 'refresh', 'openDebugFlags', 'downloadAllLogs']));
    });
  }, 20000);

  it('surfaces manual pagination when filters are active', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogsApp vscode={vscode} messageBus={bus} />);

    const searchInput = screen.getByPlaceholderText('Search logs…');
    fireEvent.change(searchInput, { target: { value: 'error' } });

    const sampleLogs = [
      {
        Id: '07L00000000000AAW',
        StartTime: '2025-09-21T22:10:00.000Z',
        Operation: 'ExecuteAnonymous',
        Application: 'Developer Console',
        DurationMilliseconds: 90,
        Status: 'Success',
        Request: 'XYZ',
        LogLength: 1024,
        LogUser: { Name: 'Alice' }
      }
    ];
    sendMessage(bus, { type: 'logs', data: sampleLogs, hasMore: true });
    sendMessage(bus, { type: 'loading', value: false });

    const loadMoreButton = await screen.findByRole('button', { name: 'Load more results' });
    const baselineLoads = posted.filter(msg => msg.type === 'loadMore').length;

    fireEvent.click(loadMoreButton);

    await waitFor(() => {
      const loadCalls = posted.filter(msg => msg.type === 'loadMore').length;
      expect(loadCalls).toBeGreaterThan(baselineLoads);
    });
  });

  it('applies errors-only filter with progressive scan status updates', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogsApp vscode={vscode} messageBus={bus} />);

    sendMessage(bus, { type: 'init', locale: 'en', fullLogSearchEnabled: true });
    sendMessage(bus, {
      type: 'logs',
      data: [
        {
          Id: '07L00000000000EAA',
          StartTime: '2025-09-21T20:00:00.000Z',
          Operation: 'ErrorCandidate',
          Application: 'VS Code',
          DurationMilliseconds: 50,
          Status: 'Success',
          Request: 'ERR',
          LogLength: 300,
          LogUser: { Name: 'Alice' }
        },
        {
          Id: '07L00000000000FAA',
          StartTime: '2025-09-21T20:01:00.000Z',
          Operation: 'NormalCandidate',
          Application: 'VS Code',
          DurationMilliseconds: 40,
          Status: 'Success',
          Request: 'OK',
          LogLength: 200,
          LogUser: { Name: 'Bob' }
        }
      ],
      hasMore: false
    });
    sendMessage(bus, { type: 'loading', value: false });
    await screen.findByText('ErrorCandidate');
    await screen.findByText('NormalCandidate');

    sendMessage(bus, { type: 'logHead', logId: '07L00000000000EAA', hasErrors: true });
    sendMessage(bus, { type: 'errorScanStatus', state: 'running', processed: 1, total: 2, errorsFound: 1 });
    await screen.findByText('Scanning logs for errors… (1/2, found: 1)');

    const toggle = screen.getByRole('switch', { name: 'Errors only' });
    fireEvent.click(toggle);

    await screen.findByText('ErrorCandidate');
    expect(screen.queryByText('NormalCandidate')).toBeNull();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});
