import assert from 'assert/strict';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '../shared/logViewerMessages';
import type { VsCodeWebviewApi } from '../webview/vscodeApi';
import { LogViewerApp } from '../webview/logViewer';

type PendingFetch = {
  url: string;
  resolve: (value: Response) => void;
  reject: (reason?: unknown) => void;
};

suite('Log Viewer App', () => {
  function createVsCodeMock() {
    const posted: LogViewerFromWebviewMessage[] = [];
    const vscode: VsCodeWebviewApi<LogViewerFromWebviewMessage> = {
      postMessage: msg => {
        posted.push(msg);
      },
      getState: () => undefined,
      setState: () => {}
    };
    return { vscode, posted };
  }

  function createPendingFetch() {
    const pending: PendingFetch[] = [];
    const fetchStub: typeof fetch = input =>
      new Promise<Response>((resolve, reject) => {
        pending.push({
          url: typeof input === 'string' ? input : input.toString(),
          resolve,
          reject
        });
      });
    return { pending, fetchStub };
  }

  function send(bus: EventTarget, message: LogViewerToWebviewMessage) {
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  }

  function createResponse(body: string, ok = true, status = 200): Response {
    return {
      ok,
      status,
      text: async () => body
    } as Response;
  }

  test('renders inline logs, fetches remote logs, and handles errors', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    const { pending, fetchStub } = createPendingFetch();

    render(<LogViewerApp vscode={vscode} messageBus={bus} fetchImpl={fetchStub} />);
    assert.equal(posted[0]?.type, 'logViewerReady');

    send(bus, {
      type: 'logViewerInit',
      logId: 'inline-log',
      locale: 'pt-BR',
      fileName: 'Inline.log',
      metadata: { sizeBytes: 1024 },
      lines: ['12:00:00.000 (0)|USER_DEBUG|[1]|Olá Mundo|Detalhe']
    });
    await screen.findByText('Olá Mundo | Detalhe');

    fireEvent.click(screen.getByText('Debug Only'));
    fireEvent.click(screen.getByText('Debug Only'));

    fireEvent.change(screen.getByPlaceholderText('Search entries…'), { target: { value: 'sem resultado' } });
    await screen.findByText('No entries match the current filters.');
    fireEvent.change(screen.getByPlaceholderText('Search entries…'), { target: { value: '' } });

    fireEvent.click(screen.getByText('View Raw'));

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-one',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-one'
    });
    assert.equal(pending.length, 1);

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-two',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-two'
    });
    assert.equal(pending.length, 2);

    await act(async () => {
      pending[0]!.resolve(createResponse('12:00:10.000 (0)|USER_DEBUG|[1]|Old|Ignored'));
    });

    await act(async () => {
      pending[1]!.resolve(createResponse('12:00:11.000 (0)|SOQL_EXECUTION_BEGIN|SELECT Id FROM Account'));
    });
    await screen.findByText('SELECT Id FROM Account');
    assert.equal(screen.queryByText('Old | Ignored'), null, 'stale fetch ignored');

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-error',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-error'
    });
    await act(async () => {
      pending[2]!.resolve(createResponse('', false, 500));
    });
    await screen.findByText('Failed to load log content: HTTP 500');

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-network',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-network'
    });
    await act(async () => {
      pending[3]!.reject(new Error('network down'));
    });
    await screen.findByText('Failed to load log content: network down');

    send(bus, { type: 'logViewerError', message: 'Falha específica' });
    await screen.findByText('Falha específica');

    send(bus, {
      type: 'logViewerInit',
      logId: 'inline-refresh',
      locale: 'pt-BR',
      lines: ['12:01:00.000 (0)|USER_DEBUG|[1]|Outro|Bloco'],
      fileName: 'Refresh.log'
    });
    await screen.findByText('Outro | Bloco');

    await waitFor(() => {
      const types = posted.map(m => m.type);
      assert.equal(types[0], 'logViewerReady');
      assert(types.includes('logViewerViewRaw'), 'view raw message emitted');
    });
  });
});
