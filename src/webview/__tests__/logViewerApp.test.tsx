import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '../shared/logViewerMessages';
import type { LogDiagnostic } from '../shared/logTriage';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { LogViewerApp } from '../logViewer';

const listScrollCalls: number[] = [];

const resetListScrollCalls = () => {
  listScrollCalls.length = 0;
};

jest.mock('react-window', () => {
  const React = require('react');
  return {
    List: ({ listRef, rowCount, rowHeight, rowComponent, rowProps, style, className }: any) => {
      const rows = Array.from({ length: rowCount }).map((_: unknown, index: number) =>
        React.createElement(
          React.Fragment,
          { key: index },
          rowComponent({
            ...rowProps,
            index,
            style: {
              height: rowHeight(index)
            }
          })
        )
      );
      const api = {
        element: null,
        scrollToRow: (opts: { index: number }) => {
          if (typeof opts === 'number') {
            listScrollCalls.push(opts);
            return;
          }
          if (typeof opts?.index === 'number') {
            listScrollCalls.push(opts.index);
          }
        }
      };
      if (typeof listRef === 'function') {
        listRef(api);
      } else if (listRef && 'current' in listRef) {
        (listRef as { current: unknown }).current = api;
      }
      return React.createElement('div', { 'data-testid': 'virtual-list', style, className }, rows);
    }
  };
});

type PendingFetch = {
  url: string;
  resolve: (value: Response) => void;
  reject: (reason?: unknown) => void;
};

describe('Log Viewer App', () => {
  beforeEach(() => {
    resetListScrollCalls();
  });

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

  it('renders inline logs, fetches remote logs, and handles errors', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    const { pending, fetchStub } = createPendingFetch();

    render(<LogViewerApp vscode={vscode} messageBus={bus} fetchImpl={fetchStub} />);
    expect(posted[0]?.type).toBe('logViewerReady');

    send(bus, {
      type: 'logViewerInit',
      logId: 'inline-log',
      locale: 'pt-BR',
      fileName: 'Inline.log',
      metadata: { sizeBytes: 1024 },
      lines: ['12:00:00.000 (0)|USER_DEBUG|[1]|Olá Mundo|Detalhe']
    });
    await screen.findByText(/Olá Mundo/);

    fireEvent.click(screen.getByText('Debug Only'));
    fireEvent.click(screen.getByText('Debug Only'));

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: 'sem resultado' } });
    await screen.findByText(/Olá Mundo/);
    screen.getByText('0/0');
    expect(screen.getByLabelText('Next match')).toBeDisabled();
    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('0/0')).toBeNull());

    fireEvent.click(screen.getByText('View Raw'));

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-one',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-one'
    });
    expect(pending).toHaveLength(1);

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-two',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-two'
    });
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0]!.resolve(createResponse('12:00:10.000 (0)|USER_DEBUG|[1]|Old|Ignored'));
    });

    await act(async () => {
      pending[1]!.resolve(createResponse('12:00:11.000 (0)|SOQL_EXECUTION_BEGIN|SELECT Id FROM Account'));
    });
    await screen.findByText('SELECT Id FROM Account');
    expect(screen.queryByText('Old | Ignored')).toBeNull();

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
      expect(types[0]).toBe('logViewerReady');
      expect(types).toContain('logViewerViewRaw');
    });
  });

  it('opens logs immediately, hydrates async triage, and scrolls only when a diagnostic is clicked', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    expect(posted[0]?.type).toBe('logViewerReady');

    send(bus, {
      type: 'logViewerInit',
      logId: 'triage-log',
      locale: 'en-US',
      fileName: 'triage.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A',
        '12:00:01.000 (2)|DML_EXECUTE_BEGIN|[2]|Database update|B',
        '12:00:02.000 (3)|EXCEPTION|[3]|Error row|C'
      ],
      metadata: { sizeBytes: 2048 }
    });

    await screen.findByText(/Alpha/);
    expect(screen.getByText('Loading diagnostics…')).toBeInTheDocument();
    expect(document.querySelector('.ring-2')).toBeNull();
    expect(listScrollCalls).toHaveLength(0);

    const diagnostics: LogDiagnostic[] = [
      { code: 'fatal_exception', severity: 'error', summary: 'Debug row has issue', line: 1 },
      { code: 'validation_failure', severity: 'warning', summary: 'Error row warning', line: 3 }
    ];

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'triage-log',
      triage: {
        hasErrors: true,
        reasons: diagnostics
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();
    const firstDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Debug row has issue/ });
    const secondDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Error row warning/ });
    expect(firstDiagnostic).toBeInTheDocument();
    expect(secondDiagnostic).toBeInTheDocument();
    expect(listScrollCalls).toHaveLength(0);
    fireEvent.click(firstDiagnostic);

    await waitFor(() => {
      expect(listScrollCalls.at(-1)).toBe(0);
    });

    resetListScrollCalls();
    fireEvent.click(secondDiagnostic);
    await waitFor(() => {
      expect(listScrollCalls.length).toBeGreaterThan(0);
    });
    expect(listScrollCalls.at(-1)).toBe(2);

    const diagnosticsErrorFilter = within(diagnosticsPanel as HTMLElement).getByRole('button', { name: 'Errors' });
    fireEvent.click(diagnosticsErrorFilter);
    expect(screen.getByText(/Error row \| C/)).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: '' } });
    fireEvent.change(searchInput, { target: { value: 'no-match-at-all' } });
    await waitFor(() => {
      expect(screen.getByText(/Error row \| C/)).toBeInTheDocument();
    });
  });

  it('clears a hidden active diagnostic when the sidebar severity filter excludes it', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'severity-filter-log',
      locale: 'en-US',
      fileName: 'severity-filter.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A',
        '12:00:01.000 (2)|EXCEPTION|[2]|Error row|B'
      ]
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'severity-filter-log',
      triage: {
        hasErrors: true,
        reasons: [
          { code: 'validation_failure', severity: 'warning', summary: 'Debug row warning', line: 1 },
          { code: 'fatal_exception', severity: 'error', summary: 'Error row issue', line: 2 }
        ]
      }
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Errors' })[0]!);
    await waitFor(() => {
      expect(screen.queryByText(/Alpha \| A/)).toBeNull();
      expect(screen.getByText(/Error row \| B/)).toBeInTheDocument();
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();

    const warningDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Debug row warning/ });
    fireEvent.click(warningDiagnostic);

    await waitFor(() => {
      expect(screen.getByText(/Alpha \| A/)).toBeInTheDocument();
    });

    fireEvent.click(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: 'Errors' }));

    await waitFor(() => {
      expect(screen.queryByText(/Alpha \| A/)).toBeNull();
      expect(screen.getByText(/Error row \| B/)).toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Debug row warning/ })).not.toBeInTheDocument();
    });
  });

  it('resets the diagnostics severity filter when a new log is loaded', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'warnings-log',
      locale: 'en-US',
      fileName: 'warnings.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'warnings-log',
      triage: {
        hasErrors: false,
        reasons: [{ code: 'validation_failure', severity: 'warning', summary: 'Initial warning', line: 1 }]
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();
    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Initial warning/ });

    fireEvent.click(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: 'Warnings' }));
    expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Initial warning/ })).toBeInTheDocument();

    send(bus, {
      type: 'logViewerInit',
      logId: 'errors-log',
      locale: 'en-US',
      fileName: 'errors.log',
      lines: ['12:00:01.000 (2)|EXCEPTION|[2]|Beta|B']
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'errors-log',
      triage: {
        hasErrors: true,
        reasons: [{ code: 'fatal_exception', severity: 'error', summary: 'Fresh error', line: 1 }]
      }
    });

    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Initial warning/ })).not.toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: /Fresh error/ })).toBeInTheDocument();
    });
  });

  it('shows triage unavailable when the terminal update omits diagnostics', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'triage-missing-log',
      locale: 'en-US',
      fileName: 'missing-triage.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    await screen.findByText('Loading diagnostics…');
    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'triage-missing-log'
    });
    await waitFor(() => expect(screen.getByText('Diagnostics unavailable.')).toBeInTheDocument());
  });

  it('preserves primaryReason-only triage summaries when no diagnostics are returned', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'triage-summary-only-log',
      locale: 'en-US',
      fileName: 'summary-only.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    await screen.findByText('Loading diagnostics…');
    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'triage-summary-only-log',
      triage: {
        hasErrors: true,
        primaryReason: 'Fatal exception',
        reasons: []
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Fatal exception')).toBeInTheDocument();
      expect(screen.queryByText('No diagnostics found.')).toBeNull();
    });
  });

  it('clears stale diagnostics when logViewerError is received after a successful open', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'error-reset-log',
      locale: 'en-US',
      fileName: 'error-reset.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A',
        '12:00:01.000 (2)|EXCEPTION|[2]|Error row|B'
      ]
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'error-reset-log',
      triage: {
        hasErrors: true,
        reasons: [{ code: 'fatal_exception', severity: 'error', summary: 'Active issue', line: 2 }]
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();
    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Active issue/ });

    send(bus, { type: 'logViewerError', message: 'Falha específica' });

    await screen.findByText('Falha específica');
    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Active issue/ })).not.toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).getByText('No diagnostics found.')).toBeInTheDocument();
    });
  });

  it('ignores stale triage updates that do not match the active log id', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'active-log',
      locale: 'en-US',
      fileName: 'active.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();

    await screen.findByText('Loading diagnostics…');
    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'other-log',
      triage: {
        hasErrors: true,
        reasons: [{ code: 'fatal_exception', severity: 'error', summary: 'Ignored issue', line: 1 }]
      }
    });

    await waitFor(
      () => {
        expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Ignored issue/ })).not.toBeInTheDocument();
      },
      { timeout: 1200 }
    );

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'active-log',
      triage: {
        hasErrors: true,
        reasons: [{ code: 'fatal_exception', severity: 'error', summary: 'Active issue', line: 1 }]
      }
    });

    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Active issue/ });
  });

  it('keeps unmapped diagnostics selectable as sidebar state without forcing row visibility', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'unmapped-log',
      locale: 'en-US',
      fileName: 'unmapped.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'unmapped-log',
      triage: {
        hasErrors: true,
        reasons: [{ code: 'suspicious_error_payload', severity: 'warning', summary: 'Unmapped issue', line: 99 }]
      }
    });

    const diagnosticsButton = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Unmapped issue/ });
    expect(diagnosticsButton).toBeInTheDocument();
    resetListScrollCalls();

    fireEvent.click(diagnosticsButton);
    await waitFor(() => {
      expect(diagnosticsButton.className).toContain('bg-amber-500/20');
    });
    expect(screen.getByText(/Unmapped issue/)).toBeInTheDocument();
    expect(listScrollCalls).toHaveLength(0);

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: 'no-match-at-all' } });
    expect(screen.getByText(/Unmapped issue/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: /Unmapped issue/ })).toBeInTheDocument();
    });
    const unmappedButton = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Unmapped issue/ });
    expect(unmappedButton.className).toContain('bg-amber-500/20');
    expect(listScrollCalls).toHaveLength(0);
  });

  it('keeps the active mapped row visible across overrides and clears stale selection on remap', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'remap-log',
      locale: 'en-US',
      fileName: 'remap.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A',
        '12:00:01.000 (2)|DML_EXECUTE_BEGIN|[2]|Database update|B',
        '12:00:02.000 (3)|EXCEPTION|[3]|Error row|C'
      ]
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'remap-log',
      triage: {
        hasErrors: true,
        reasons: [
          { code: 'fatal_exception', severity: 'error', summary: 'Debug row has issue', line: 1 },
          { code: 'validation_failure', severity: 'warning', summary: 'Error row warning', line: 3 }
        ]
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();
    const firstDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Debug row has issue/ });
    const secondDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Error row warning/ });

    fireEvent.click(firstDiagnostic);
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();

    const diagnosticsErrorFilter = within(diagnosticsPanel as HTMLElement).getByRole('button', { name: 'Errors' });
    fireEvent.click(diagnosticsErrorFilter);
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();

    send(bus, {
      type: 'logViewerInit',
      logId: 'remap-refresh',
      locale: 'en-US',
      fileName: 'remap.log',
      lines: ['12:00:03.000 (4)|EXCEPTION|[4]|Refreshed row|D']
    });
    await screen.findByText(/Refreshed row/);

    expect(screen.queryByText(/Alpha/)).toBeNull();
    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Debug row has issue/ })).not.toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Error row warning/ })).not.toBeInTheDocument();
    });
  });
});
