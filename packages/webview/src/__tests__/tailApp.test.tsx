import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage
} from '@alv/protocol/messages';
import type { OrgItem } from '@alv/protocol/types';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { TailApp } from '../tail';

function renderNativeSelectsInEachTest() {
  const globalDoc = globalThis as unknown as { DocumentFragment: typeof DocumentFragment | undefined };
  const originalDocumentFragment = globalDoc.DocumentFragment;
  beforeEach(() => {
    globalDoc.DocumentFragment = undefined;
  });
  afterEach(() => {
    globalDoc.DocumentFragment = originalDocumentFragment;
  });
}

describe('Tail webview App', () => {
  function createVsCodeMock(initialState?: unknown) {
    const posted: WebviewToExtensionMessage[] = [];
    let savedState = initialState;
    let getStateCallCount = 0;
    const vscode: VsCodeWebviewApi<WebviewToExtensionMessage> = {
      postMessage: msg => {
        posted.push(msg);
      },
      getState: () => {
        getStateCallCount += 1;
        return savedState as any;
      },
      setState: state => {
        savedState = state;
      }
    };
    return {
      vscode,
      posted,
      getSavedState: () => savedState,
      getStateCallCount: () => getStateCallCount
    };
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
    await act(async () => {
      await Promise.resolve();
    });

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
    fireEvent.click(screen.getByRole('button', { name: 'Debug Flags' }));

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
      expect(types).toEqual(
        expect.arrayContaining(['tailStart', 'tailStop', 'tailClear', 'openLog', 'replay', 'openDebugFlags'])
      );
    });
  }, 15000);

  it('reads initial saved UI state only once across rerenders', async () => {
    const { vscode, getStateCallCount } = createVsCodeMock({ query: 'seed query' });
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    expect(getStateCallCount()).toBe(1);

    send(bus, { type: 'tailStatus', running: true });
    await screen.findByText('Stop');

    expect(getStateCallCount()).toBe(1);
  });

  it('falls back to the first available debug level when the active selection changes', async () => {
    const { vscode, posted } = createVsCodeMock();
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    send(bus, { type: 'init', locale: 'en' });
    await screen.findByText('Start');

    send(bus, { type: 'debugLevels', data: ['LEGACY'], active: 'LEGACY' });
    await act(async () => {
      await Promise.resolve();
    });

    send(bus, { type: 'debugLevels', data: ['ALV_E2E'], active: undefined });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'ALV_E2E' });
    });
  });

  it('applies an updated tail buffer size before processing immediate replayed lines', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    send(bus, { type: 'init', locale: 'en' });
    await screen.findByText('Start');

    const replayLines = [
      'USER_DEBUG|keep-this-line',
      ...Array.from({ length: 10019 }, (_, index) => `USER_DEBUG|line-${index + 1}`)
    ];

    send(bus, { type: 'tailConfig', tailBufferSize: replayLines.length });
    send(bus, { type: 'tailData', lines: replayLines });

    fireEvent.change(screen.getByPlaceholderText('Search live logs…'), {
      target: { value: 'keep-this-line' }
    });

    await screen.findByText('USER_DEBUG|keep-this-line');
  });

  it('pauses Auto-scroll when the user scrolls up and resumes it at the bottom', async () => {
    const { vscode, getSavedState } = createVsCodeMock();
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    send(bus, { type: 'init', locale: 'en' });
    send(bus, {
      type: 'tailData',
      lines: Array.from({ length: 40 }, (_, i) => `13:00:${String(i).padStart(2, '0')}.000|INFO|line-${i}`)
    });
    await screen.findByText('13:00:00.000|INFO|line-0');

    const autoScroll = screen.getByRole('switch', { name: 'Auto-scroll' });
    expect(autoScroll).toHaveAttribute('aria-checked', 'true');

    const list = screen.getByRole('list');
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    const scrollListTo = (top: number) => {
      act(() => {
        list.scrollTop = top;
        fireEvent.scroll(list);
      });
    };

    scrollListTo(300);
    await waitFor(() => expect(autoScroll).toHaveAttribute('aria-checked', 'false'));
    expect((getSavedState() as any)?.autoScroll).toBe(false);

    scrollListTo(800);
    await waitFor(() => expect(autoScroll).toHaveAttribute('aria-checked', 'true'));
    expect((getSavedState() as any)?.autoScroll).toBe(true);
  });

  it('restores and persists tail UI state through the VS Code webview api', async () => {
    const { vscode, posted, getSavedState } = createVsCodeMock({
      query: 'persisted tail query',
      onlyUserDebug: true,
      autoScroll: false,
      colorize: true,
      debugLevelByOrg: { 'user@example.com': 'CLOUD' }
    });
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);

    send(bus, { type: 'init', locale: 'en' });
    send(bus, { type: 'orgs', data: [{ username: 'user@example.com' }], selected: 'user@example.com' });
    send(bus, { type: 'debugLevels', data: ['DETAILED', 'CLOUD'], active: 'DETAILED' });
    await screen.findByText('Start');

    const searchInput = screen.getByPlaceholderText('Search live logs…') as HTMLInputElement;
    expect(searchInput.value).toBe('persisted tail query');

    fireEvent.change(searchInput, { target: { value: 'updated tail query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect((getSavedState() as any)?.query).toBe('updated tail query');
      expect((getSavedState() as any)?.onlyUserDebug).toBe(true);
      expect((getSavedState() as any)?.autoScroll).toBe(false);
      expect((getSavedState() as any)?.colorize).toBe(true);
    });

    await waitFor(() => {
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'CLOUD' });
    });
  });

  describe('debug level per org', () => {
    const orgA = 'a@example.com';
    const orgB = 'b@example.com';
    const orgs: OrgItem[] = [
      { username: orgA, alias: 'Org A', isDefaultUsername: true },
      { username: orgB, alias: 'Org B' }
    ];
    const levelsOnA = ['ALV_E2E', 'SFDC_DevConsole'];
    const levelsOnB = ['SFDC_DevConsole'];

    renderNativeSelectsInEachTest();

    const levelSelect = () => screen.getByTestId('tail-debug-level') as HTMLSelectElement;
    const pickLevel = (level: string) => fireEvent.change(levelSelect(), { target: { value: level } });
    const pressStart = () => fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    function renderTail(initialState?: unknown) {
      const mock = createVsCodeMock(initialState);
      const bus = new EventTarget();
      const view = render(<TailApp vscode={mock.vscode} messageBus={bus} />);
      send(bus, { type: 'init', locale: 'en' });
      return { ...mock, ...view, bus };
    }

    function hostShows(bus: EventTarget, org: string, levels: string[], active?: string) {
      send(bus, { type: 'orgs', data: orgs, selected: org });
      send(bus, { type: 'debugLevels', data: levels, active });
    }

    function switchOrg(bus: EventTarget, org: string, levels: string[], active?: string) {
      fireEvent.change(screen.getByLabelText('Org'), { target: { value: org } });
      hostShows(bus, org, levels, active);
    }

    it.each([
      { pick: 'ALV_E2E', activeOnA: 'ALV_E2E' },
      { pick: 'ALV_E2E', activeOnA: 'SFDC_DevConsole' },
      { pick: 'SFDC_DevConsole', activeOnA: 'ALV_E2E' }
    ])('keeps $pick through a round trip to another org when A is active at $activeOnA', ({ pick, activeOnA }) => {
      const { bus, posted } = renderTail();
      hostShows(bus, orgA, levelsOnA, activeOnA);
      pickLevel(pick);

      switchOrg(bus, orgB, levelsOnB, 'SFDC_DevConsole');
      expect(levelSelect().value).toBe('SFDC_DevConsole');

      switchOrg(bus, orgA, levelsOnA, activeOnA);
      expect(levelSelect().value).toBe(pick);

      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: pick });
    });

    it('does not carry a pick to another org that has the same level', () => {
      const { bus, posted } = renderTail();
      hostShows(bus, orgA, levelsOnA, 'SFDC_DevConsole');
      pickLevel('ALV_E2E');

      switchOrg(bus, orgB, levelsOnA, 'SFDC_DevConsole');

      expect(levelSelect().value).toBe('SFDC_DevConsole');
      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'SFDC_DevConsole' });
    });

    it('keeps a pick when the level reply of another org arrives late', () => {
      const { bus } = renderTail();
      hostShows(bus, orgA, levelsOnA, 'SFDC_DevConsole');
      pickLevel('ALV_E2E');
      switchOrg(bus, orgB, levelsOnB, 'SFDC_DevConsole');

      fireEvent.change(screen.getByLabelText('Org'), { target: { value: orgA } });
      send(bus, { type: 'orgs', data: orgs, selected: orgA });
      send(bus, { type: 'debugLevels', data: levelsOnB, active: 'SFDC_DevConsole' });
      send(bus, { type: 'debugLevels', data: levelsOnA, active: 'SFDC_DevConsole' });

      expect(levelSelect().value).toBe('ALV_E2E');
    });

    it("does not carry another org's fallback back when nothing was picked", () => {
      const { bus } = renderTail();
      hostShows(bus, orgA, levelsOnA, 'ALV_E2E');

      switchOrg(bus, orgB, levelsOnB, 'SFDC_DevConsole');
      switchOrg(bus, orgA, levelsOnA, 'ALV_E2E');

      expect(levelSelect().value).toBe('ALV_E2E');
    });

    it('reads the remembered level when the org arrives after the levels', () => {
      const { bus } = renderTail({ debugLevelByOrg: { [orgA]: 'ALV_E2E' } });
      send(bus, { type: 'orgs', data: [], selected: undefined });
      send(bus, { type: 'debugLevels', data: levelsOnA, active: 'SFDC_DevConsole' });
      expect(levelSelect().value).toBe('SFDC_DevConsole');

      send(bus, { type: 'orgs', data: orgs, selected: orgA });

      expect(levelSelect().value).toBe('ALV_E2E');
    });

    it('honors a pick made while no org is known', () => {
      const { bus, posted } = renderTail();
      send(bus, { type: 'debugLevels', data: levelsOnA, active: 'ALV_E2E' });

      pickLevel('SFDC_DevConsole');

      expect(levelSelect().value).toBe('SFDC_DevConsole');
      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'SFDC_DevConsole' });
    });

    it('returns to the active level when the Select placeholder is chosen', () => {
      const { bus, posted } = renderTail();
      hostShows(bus, orgA, levelsOnA, 'SFDC_DevConsole');
      pickLevel('ALV_E2E');

      pickLevel('');

      expect(levelSelect().value).toBe('SFDC_DevConsole');
      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'SFDC_DevConsole' });
    });

    it('falls back to the active level, then the first level, when the remembered level was deleted', () => {
      const { bus, posted } = renderTail();
      hostShows(bus, orgA, ['ALV_E2E', 'FINE', 'SFDC_DevConsole'], 'FINE');
      pickLevel('ALV_E2E');

      hostShows(bus, orgA, ['FINE', 'SFDC_DevConsole'], 'SFDC_DevConsole');
      expect(levelSelect().value).toBe('SFDC_DevConsole');

      hostShows(bus, orgA, ['FINE', 'SFDC_DevConsole'], undefined);
      expect(levelSelect().value).toBe('FINE');

      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'FINE' });
    });

    it('keeps the level Start used after the trace flag expires', () => {
      const { bus, posted } = renderTail();
      hostShows(bus, orgA, levelsOnA, 'SFDC_DevConsole');
      pressStart();
      expect(posted).toContainEqual({ type: 'tailStart', debugLevel: 'SFDC_DevConsole' });

      hostShows(bus, orgA, levelsOnA, 'ALV_E2E');

      expect(levelSelect().value).toBe('SFDC_DevConsole');
    });

    it('restores the level of each org after a reload', () => {
      const first = renderTail();
      hostShows(first.bus, orgA, levelsOnA, 'SFDC_DevConsole');
      pickLevel('ALV_E2E');
      switchOrg(first.bus, orgB, ['FINE', 'SFDC_DevConsole'], 'SFDC_DevConsole');
      pickLevel('FINE');
      const saved = first.getSavedState();
      first.unmount();

      const second = renderTail(saved);
      hostShows(second.bus, orgB, ['FINE', 'SFDC_DevConsole'], 'SFDC_DevConsole');
      expect(levelSelect().value).toBe('FINE');

      switchOrg(second.bus, orgA, levelsOnA, 'SFDC_DevConsole');
      expect(levelSelect().value).toBe('ALV_E2E');
    });

    it.each([
      { debugLevel: 'SFDC_DevConsole' },
      { debugLevelByOrg: 'SFDC_DevConsole' },
      { debugLevelByOrg: null },
      { debugLevelByOrg: { [orgA]: 7 } }
    ])('opens on the active level with the persisted state %j', persisted => {
      const { bus } = renderTail(persisted);

      hostShows(bus, orgA, levelsOnA, 'ALV_E2E');

      expect(levelSelect().value).toBe('ALV_E2E');
    });
  });
});
