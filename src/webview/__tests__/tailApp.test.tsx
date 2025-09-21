import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { TailApp } from '../tail';

describe('Tail webview App', () => {
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

  function send(bus: EventTarget, message: ExtensionToWebviewMessage) {
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  }

  it('tails logs, trims buffer, and exposes tail actions', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    expect(posted[0]?.type).toBe('ready');

    send(bus, { type: 'init', locale: 'pt-BR' });
    await screen.findByText('Iniciar');

    send(bus, { type: 'debugLevels', data: ['DETAILED', 'CLOUD'], active: 'DETAILED' });
    send(bus, { type: 'tailConfig', tailBufferSize: 5 });
    await act(async () => {});

    const headerOne = '=== ApexLog 07L000001 | 2025-09-21T18:50:00.000Z | user@example.com';
    send(bus, {
      type: 'tailData',
      lines: [headerOne, '13:00:01.000|INFO|line-1', '13:00:02.000|DEBUG|line-2']
    });

    const headerTwo = '=== ApexLog 07L000002 | 2025-09-21T18:55:00.000Z | user@example.com';
    send(bus, {
      type: 'tailData',
      lines: [headerTwo, '13:00:03.000|USER_DEBUG|line-3', '13:00:04.000|METHOD_ENTRY|line-4']
    });

    send(bus, {
      type: 'tailData',
      lines: ['13:00:05.000|USER_DEBUG|line-5', '13:00:06.000|INFO|line-6']
    });

    await screen.findByText('13:00:05.000|USER_DEBUG|line-5');
    await waitFor(() => expect(screen.queryByText(headerOne)).toBeNull());

    send(bus, { type: 'tailStatus', running: true });
    await screen.findByText('Parar');
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));

    send(bus, { type: 'tailStatus', running: false });
    await screen.findByText('Iniciar');
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));

    fireEvent.click(screen.getByText('13:00:03.000|USER_DEBUG|line-3'));
    const openBtn = screen.getByRole('button', { name: 'Abrir Log' });
    await waitFor(() => expect(openBtn.hasAttribute('disabled')).toBe(false));
    fireEvent.click(openBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Replay Debugger' }));

    fireEvent.click(screen.getByLabelText('Somente USER_DEBUG'));
    await waitFor(() => {
      expect(screen.queryByText('13:00:04.000|METHOD_ENTRY|line-4')).toBeNull();
    });
    fireEvent.click(screen.getByLabelText('Somente USER_DEBUG'));

    fireEvent.click(screen.getByLabelText('Rolagem automática'));
    fireEvent.click(screen.getByLabelText('Rolagem automática'));

    send(bus, { type: 'error', message: 'Erro de tail' });
    await screen.findByText('Erro de tail');

    send(bus, { type: 'tailReset' });
    await screen.findByText('Pressione Iniciar para acompanhar os logs.');

    await waitFor(() => {
      const types = posted.map(m => m.type);
      expect(types).toEqual(expect.arrayContaining(['tailStart', 'tailStop', 'tailClear', 'openLog', 'replay']));
    });
  });
});
