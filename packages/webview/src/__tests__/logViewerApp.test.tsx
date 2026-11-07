import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '@alv/protocol/logViewerMessages';
import type { LogDiagnostic } from '@alv/protocol/logTriage';
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
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input instanceof Request
                ? input.url
                : '';
        pending.push({
          url,
          resolve,
          reject
        });
      });
    return { pending, fetchStub };
  }

  const entryList = () => within(screen.getByTestId('virtual-list'));

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
    // A pt-BR log opens in Portuguese.
    screen.getByText('1 entrada');
    screen.getByText('Total de linhas: 1');
    screen.getByText('Diagnósticos');

    fireEvent.click(screen.getByText('Somente debug'));
    fireEvent.click(screen.getByText('Somente debug'));

    const searchInput = screen.getByPlaceholderText('Buscar entradas…');
    fireEvent.change(searchInput, { target: { value: 'sem resultado' } });
    await screen.findByText(/Olá Mundo/);
    screen.getByText('0/0');
    expect(screen.getByLabelText('Próxima ocorrência')).toBeDisabled();
    fireEvent.change(searchInput, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('0/0')).toBeNull());

    fireEvent.click(screen.getByText('Ver bruto'));

    send(bus, {
      type: 'logViewerInit',
      logId: 'remote-one',
      locale: 'en-US',
      fileName: 'Remote.log',
      logUri: 'https://example.com/log-one'
    });
    expect(pending).toHaveLength(1);
    // The status bar says the content is still on its way, not Ready.
    screen.getByText('Loading log entries…');
    screen.getByText('Loading…');
    expect(screen.queryByText('Ready')).toBeNull();

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
    screen.getByText('Ready');

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
    screen.getByText('Not loaded');

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

  it('starts a new query at its first match, and keeps the place of the same query when the filter changes', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogViewerApp vscode={vscode} messageBus={bus} />);

    send(bus, {
      type: 'logViewerInit',
      logId: 'matches',
      locale: 'en-US',
      fileName: 'Matches.log',
      lines: [
        '12:00:00.000 (0)|USER_DEBUG|[1]|DEBUG|alpha one',
        '12:00:01.000 (0)|USER_DEBUG|[2]|DEBUG|alpha two',
        '12:00:02.000 (0)|USER_DEBUG|[3]|DEBUG|alpha three',
        '12:00:03.000 (0)|SOQL_EXECUTION_BEGIN|[4]|SELECT Id FROM Alpha',
        '12:00:04.000 (0)|USER_DEBUG|[5]|DEBUG|beta one',
        '12:00:05.000 (0)|USER_DEBUG|[6]|DEBUG|beta two',
        '12:00:06.000 (0)|USER_DEBUG|[7]|DEBUG|beta three'
      ]
    });
    await screen.findByText(/alpha one/);

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: 'alpha' } });
    screen.getByText('1/4');
    fireEvent.click(screen.getByLabelText('Next match'));
    screen.getByText('2/4');

    // Debug Only drops the SOQL row: the same query keeps its second match.
    fireEvent.click(screen.getByText('Debug Only'));
    screen.getByText('2/3');

    // A new query starts at its first match instead of reusing the second.
    fireEvent.change(searchInput, { target: { value: 'beta' } });
    screen.getByText('1/3');
  });

  it('shows the pipes the developer wrote in the failure banner', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogViewerApp vscode={vscode} messageBus={bus} />);

    send(bus, {
      type: 'logViewerInit',
      logId: 'failure-pipes',
      locale: 'en-US',
      fileName: 'FailurePipes.log',
      lines: ['10:19:25.120 (177599203)|FATAL_ERROR|System.IllegalArgumentException: fatal&#124;one']
    });

    expect(await screen.findByTestId('log-viewer-failure')).toHaveTextContent(
      'System.IllegalArgumentException: fatal|one'
    );
  });

  it('finds a debug entry by the pipes it shows and by the text in the log', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<LogViewerApp vscode={vscode} messageBus={bus} />);

    send(bus, {
      type: 'logViewerInit',
      logId: 'pipes',
      locale: 'en-US',
      fileName: 'Pipes.log',
      lines: [
        '12:00:00.000 (0)|USER_DEBUG|[1]|ERROR|order=42&#124;status=FAILED',
        '12:00:01.000 (0)|USER_DEBUG|[2]|ERROR|other'
      ]
    });
    await screen.findByText('ERROR | order=42|status=FAILED');

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: 'order=42|status' } });
    screen.getByText('1/1');

    fireEvent.change(searchInput, { target: { value: 'order=42&#124;status' } });
    screen.getByText('1/1');
  });

  it('keeps multiline JSON from USER_DEBUG visible as one formatted debug entry', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'serialize-pretty-log',
      locale: 'en-US',
      fileName: 'serialize-pretty.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[7]|DEBUG|{',
        '  "account" : {',
        '    "name" : "Acme"',
        '  }',
        '}',
        '12:00:01.000 (2)|METHOD_EXIT|[7]|Example.run()'
      ]
    });

    fireEvent.click(await screen.findByRole('button', { name: /Debug Only/ }));

    const jsonEntry = await screen.findByText(content => content.includes('"account"') && content.includes('"name"'));
    expect(jsonEntry).toHaveTextContent('DEBUG | { "account" : { "name" : "Acme" } }');
    expect(jsonEntry.className).toContain('whitespace-pre-wrap');
    expect(screen.queryByText('Example.run()')).toBeNull();
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
    expect(document.querySelector('.log-selected')).toBeNull();
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
    const secondDiagnostic = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Error row \| C/ });
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
    expect(entryList().getByText(/Error row \| C/)).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText('Search entries…');
    fireEvent.change(searchInput, { target: { value: '' } });
    fireEvent.change(searchInput, { target: { value: 'no-match-at-all' } });
    await waitFor(() => {
      expect(entryList().getByText(/Error row \| C/)).toBeInTheDocument();
    });
  });

  it('scrolls to the eventType-matched row when diagnostics target a duplicated line number', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'duplicate-line-log',
      locale: 'en-US',
      fileName: 'duplicate-line.log',
      lines: [
        '12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A',
        '12:00:01.000 (2)|VARIABLE_SCOPE_BEGIN|[66]|LoggerConfigurationSelector.mockLogEntryDataMaskRules|List<LogEntryDataMaskRule__mdt>|true|true',
        '12:00:02.000 (3)|EXCEPTION_THROWN|[66]|System.DmlException: Insert failed. First exception on row 0; first error: DUPLICATE_VALUE'
      ]
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'duplicate-line-log',
      triage: {
        hasErrors: true,
        reasons: [
          {
            code: 'dml_failure',
            severity: 'error',
            summary: 'DML failure',
            line: 66,
            eventType: 'EXCEPTION_THROWN'
          }
        ]
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();

    const diagnosticButton = await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Insert failed/ });
    fireEvent.click(diagnosticButton);

    await waitFor(() => {
      expect(listScrollCalls.at(-1)).toBe(2);
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

    fireEvent.click(screen.getByRole('button', { name: 'Errors 1' }));
    await waitFor(() => {
      expect(screen.queryByText(/Alpha \| A/)).toBeNull();
      expect(entryList().getByText(/Error row \| B/)).toBeInTheDocument();
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
      expect(entryList().getByText(/Error row \| B/)).toBeInTheDocument();
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
      expect(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: /Beta \| B/ })).toBeInTheDocument();
    });
  });

  it('shows an empty filtered state instead of the summary card when a severity has no matches', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();

    render(<LogViewerApp vscode={vscode} messageBus={bus} />);
    send(bus, {
      type: 'logViewerInit',
      logId: 'warning-only-log',
      locale: 'en-US',
      fileName: 'warning-only.log',
      lines: ['12:00:00.000 (1)|USER_DEBUG|[1]|Alpha|A']
    });

    send(bus, {
      type: 'logViewerTriageUpdate',
      logId: 'warning-only-log',
      triage: {
        hasErrors: false,
        primaryReason: 'Validation warning',
        reasons: [{ code: 'validation_failure', severity: 'warning', summary: 'Validation warning', line: 1 }]
      }
    });

    const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside');
    expect(diagnosticsPanel).not.toBeNull();
    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Validation warning/ });

    fireEvent.click(within(diagnosticsPanel as HTMLElement).getByRole('button', { name: 'Errors' }));

    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).getByText('No diagnostics found.')).toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).queryByText('Summary')).toBeNull();
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Validation warning/ })).toBeNull();
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
    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Error row \| B/ });

    send(bus, { type: 'logViewerError', message: 'Falha específica' });

    await screen.findByText('Falha específica');
    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Error row \| B/ })).not.toBeInTheDocument();
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
      expect(diagnosticsButton.className).toContain('log-selected');
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
    expect(unmappedButton.className).toContain('log-selected');
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
    await within(diagnosticsPanel as HTMLElement).findByRole('button', { name: /Error row \| C/ });

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
    await entryList().findByText(/Refreshed row/);

    expect(screen.queryByText(/Alpha/)).toBeNull();
    await waitFor(() => {
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Debug row has issue/ })).not.toBeInTheDocument();
      expect(within(diagnosticsPanel as HTMLElement).queryByRole('button', { name: /Error row \| C/ })).not.toBeInTheDocument();
    });
  });

  describe('failure banner and identity', () => {
    const failingLines = [
      '65.0 APEX_CODE,DEBUG',
      '14:03:21.5 (1000000)|EXECUTION_STARTED',
      '14:03:21.5 (2000000)|USER_INFO|[EXTERNAL]|005Hs00000AbCdE|ana@example.com|Pacific Standard Time|GMT-08:00',
      '14:03:21.5 (3000000)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
      '14:03:21.5 (4000000)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account LIMIT 3',
      '14:03:21.5 (5000000)|USER_DEBUG|[1]|DEBUG|n=3',
      '14:03:21.9 (185000000)|EXCEPTION_THROWN|[1]|System.MathException: Divide by 0',
      '14:03:21.9 (186000000)|FATAL_ERROR|System.MathException: Divide by 0',
      '',
      'AnonymousBlock: line 1, column 1',
      '14:03:21.9 (187000000)|CODE_UNIT_FINISHED|execute_anonymous_apex'
    ];

    function open(lines: string[]) {
      const { vscode } = createVsCodeMock();
      const bus = new EventTarget();
      render(<LogViewerApp vscode={vscode} messageBus={bus} />);
      send(bus, {
        type: 'logViewerInit',
        logId: 'banner-log',
        locale: 'en-US',
        fileName: '07L000000000001.log',
        lines
      });
      return bus;
    }

    it('says why the log failed, names the log by what it ran, and jumps to the failing entry', async () => {
      open(failingLines);

      const banner = await screen.findByRole('alert', { name: 'Failure' });
      expect(within(banner).getByText('System.MathException: Divide by 0')).toBeInTheDocument();
      expect(within(banner).getByText('Line 1')).toBeInTheDocument();

      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent('execute_anonymous_apex');
      expect(heading.nextElementSibling).toHaveTextContent('ana@example.com · 186 ms · 14:03:21 · 07L000000000001.log');

      expect(document.querySelector('.log-selected')).toBeNull();
      resetListScrollCalls();
      fireEvent.click(within(banner).getByRole('button', { name: 'Go to error' }));

      await waitFor(() => expect(listScrollCalls.at(-1)).toBe(7));
      const selected = document.querySelector('.log-selected');
      expect(selected).toHaveTextContent('FATAL_ERROR');

      resetListScrollCalls();
      fireEvent.click(within(banner).getByRole('button', { name: 'Go to error' }));
      await waitFor(() => expect(listScrollCalls.at(-1)).toBe(7));
    });

    it('brings the failing entry back when a filter had hidden it, and lets a diagnostic take over', async () => {
      const bus = open(failingLines);
      send(bus, {
        type: 'logViewerTriageUpdate',
        logId: 'banner-log',
        triage: {
          hasErrors: true,
          reasons: [{ code: 'fatal_exception', severity: 'error', summary: 'Fatal exception', line: 1, eventType: 'EXCEPTION_THROWN' }]
        }
      });

      fireEvent.click(await screen.findByRole('button', { name: /Debug Only/ }));
      expect(entryList().queryByText('FATAL_ERROR')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Go to error' }));
      await waitFor(() => expect(entryList().getByText('FATAL_ERROR')).toBeInTheDocument());

      const diagnosticsPanel = screen.getByText('Diagnostics').closest('aside') as HTMLElement;
      fireEvent.click(within(diagnosticsPanel).getByRole('button', { name: /Divide by 0/ }));
      await waitFor(() => expect(entryList().queryByText('FATAL_ERROR')).toBeNull());
      expect(entryList().getByText('EXCEPTION_THROWN')).toBeInTheDocument();
    });

    it('stays on the failing entry when a search has an active match elsewhere', async () => {
      open(failingLines);
      await screen.findByRole('alert', { name: 'Failure' });

      fireEvent.change(screen.getByPlaceholderText('Search entries…'), { target: { value: 'n=3' } });
      await waitFor(() => expect(listScrollCalls.at(-1)).toBe(5));

      resetListScrollCalls();
      fireEvent.click(screen.getByRole('button', { name: 'Go to error' }));
      await waitFor(() => expect(listScrollCalls.at(-1)).toBe(7));
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(listScrollCalls.at(-1)).toBe(7);
    });

    it('stays on the failing entry when a filter had hidden it and a search is active', async () => {
      open(failingLines);
      await screen.findByRole('alert', { name: 'Failure' });

      fireEvent.change(screen.getByPlaceholderText('Search entries…'), { target: { value: 'n=3' } });
      fireEvent.click(screen.getByRole('button', { name: /Debug Only/ }));
      await waitFor(() => expect(entryList().queryByText('FATAL_ERROR')).toBeNull());

      resetListScrollCalls();
      fireEvent.click(screen.getByRole('button', { name: 'Go to error' }));
      await waitFor(() => expect(entryList().getByText('FATAL_ERROR')).toBeInTheDocument());
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      expect(listScrollCalls.at(-1)).toBe(1);
    });

    it('shows no banner for a clean log and falls back to the file name for the title', async () => {
      open(['12:00:00.0 (1000)|USER_DEBUG|[1]|DEBUG|all good']);

      await entryList().findByText(/all good/);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('07L000000000001.log');
    });

    it('shows the count on every filter chip and disables a chip with nothing to show', async () => {
      open(failingLines);

      const errors = await screen.findByRole('button', { name: 'Errors 2' });
      expect(errors).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Debug Only 1' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'SOQL 1' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'DML 0' })).toBeDisabled();

      fireEvent.click(errors);
      expect(screen.getByRole('button', { name: 'Errors 2' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('2 entries')).toBeInTheDocument();
    });
  });
});
