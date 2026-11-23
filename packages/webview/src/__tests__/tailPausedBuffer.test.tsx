import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@alv/protocol';
import { TailApp } from '../tail';
import type { VsCodeWebviewApi } from '../vscodeApi';

// While Auto-scroll is off, the panel keeps older lines instead of dropping them, so the lines in view do not move.

function createVsCodeMock(initialState?: unknown) {
  let savedState = initialState;
  const posted: WebviewToExtensionMessage[] = [];
  const vscode: VsCodeWebviewApi<WebviewToExtensionMessage> = {
    postMessage: message => posted.push(message),
    getState: () => savedState as any,
    setState: state => {
      savedState = state;
    }
  };
  return { vscode, getSavedState: () => savedState as any, posted };
}

function send(bus: EventTarget, message: ExtensionToWebviewMessage) {
  act(() => {
    bus.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const numbered = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line-${from + i}`);
/** Numbered lines in logs of 100: every hundredth line is the header of the log the lines below it belong to. */
const logged = (from: number, count: number, text = (seq: number) => `line-${seq}`) =>
  Array.from({ length: count }, (_, i) =>
    (from + i) % 100 ? text(from + i) : `=== ApexLog L${(from + i) / 100} | user`
  );
const rowOf = (text: string) => screen.queryByText(text)?.closest<HTMLElement>('[role="row"]') ?? null;
const offsetOf = (row: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]);

/** The text of the row the List places first, which is the first line of the buffer while the view is at the top. */
function firstRowText() {
  const rows = screen.queryAllByRole('row').sort((a, b) => offsetOf(a) - offsetOf(b));
  return rows[0]?.textContent ?? '';
}

function selectedRowText() {
  return (
    screen
      .queryAllByRole('row')
      .find(row => (row.firstElementChild as HTMLElement | null)?.style.borderLeft.includes('focusBorder'))
      ?.textContent ?? undefined
  );
}

/** Selects `line` through the search, wherever it is in the list, then clears the search. */
function pickLine(line: string) {
  const search = screen.getByPlaceholderText('Search live logs…');
  fireEvent.change(search, { target: { value: `${line} ` } });
  fireEvent.click(screen.getByText(line));
  fireEvent.change(search, { target: { value: '' } });
}

/** The selected line among those the search shows for `line`. */
function selectedAmongLines(line: string) {
  fireEvent.change(screen.getByPlaceholderText('Search live logs…'), { target: { value: `${line} ` } });
  return selectedRowText();
}

/**
 * Counts every scroll of the list by code: writes of its offset, `scrollTo` and `scrollBy` (which the List's
 * `scrollToRow` calls) and `scrollIntoView` on any element. The offset stays readable.
 */
function spyOnScrollWrites(list: HTMLElement) {
  let top = list.scrollTop;
  let writes = 0;
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      writes++;
      top = value;
    }
  });
  const count = () => {
    writes++;
  };
  Object.assign(list, { scrollTo: count, scrollBy: count });
  Element.prototype.scrollIntoView = count;
  return () => writes;
}

function scrollTo(list: HTMLElement, top: number) {
  act(() => {
    list.scrollTop = top;
    fireEvent.scroll(list);
  });
}

async function openPaused(limit = 1000, strict = false) {
  const { vscode, getSavedState, posted } = createVsCodeMock({ autoScroll: false });
  const bus = new EventTarget();
  const app = <TailApp vscode={vscode} messageBus={bus} />;
  const view = render(strict ? <React.StrictMode>{app}</React.StrictMode> : app);
  send(bus, { type: 'init', locale: 'en' });
  send(bus, { type: 'tailConfig', tailBufferSize: limit });
  return { vscode, getSavedState, posted, bus, view };
}

/** The logs Open Log asks the extension for, or none when it is disabled because no line is selected. */
function openLogIds(posted: WebviewToExtensionMessage[]) {
  const button = screen.getByRole('button', { name: 'Open Log' });
  if (!button.hasAttribute('disabled')) {
    fireEvent.click(button);
  }
  return posted.flatMap(message => (message.type === 'openLog' ? [message.logId] : []));
}

const autoScrollSwitch = () => screen.getByRole('switch', { name: 'Auto-scroll' });

describe('Tail buffer while Auto-scroll is off', () => {
  it('keeps the lines in view in place as lines arrive in a full buffer, without writing the scroll offset', async () => {
    const { bus } = await openPaused();
    send(bus, { type: 'tailData', lines: numbered(0, 1000) });
    const row = (await screen.findByText('line-5')).closest<HTMLElement>('[role="row"]')!;
    const offset = offsetOf(row);
    const writes = spyOnScrollWrites(screen.getByRole('list'));

    for (let next = 1000; next < 1060; next++) {
      send(bus, { type: 'tailData', lines: [`line-${next}`] });
    }

    expect(rowOf('line-5')).toBe(row);
    expect(offsetOf(row)).toBe(offset);
    expect(firstRowText()).toBe('line-0');
    expect(writes()).toBe(0);
  });

  it('writes no scroll offset while lines arrive during keys, the wheel, a smooth scroll and a held thumb', async () => {
    const { bus } = await openPaused();
    send(bus, { type: 'tailData', lines: numbered(0, 1000) });
    const row = (await screen.findByText('line-5')).closest<HTMLElement>('[role="row"]')!;
    const offset = offsetOf(row);
    const list = screen.getByRole('list');
    const writes = spyOnScrollWrites(list);
    const gestures = [
      () => fireEvent.keyDown(list, { key: 'End' }),
      () => fireEvent.keyDown(list, { key: 'PageUp' }),
      () => fireEvent.wheel(list, { deltaY: -40 }),
      () => fireEvent.scroll(list),
      () => fireEvent.pointerDown(list),
      () => fireEvent.pointerUp(window)
    ];

    let next = 1000;
    for (const gesture of gestures) {
      act(() => {
        gesture();
      });
      send(bus, { type: 'tailData', lines: numbered(next, 10) });
      next += 10;
    }

    expect(offsetOf(rowOf('line-5')!)).toBe(offset);
    expect(writes()).toBe(0);
  });

  it('keeps at most twice the limit and at least 20,000 more, then drops lines from the head as before', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 21000) });
    await screen.findByText('line-0');

    send(bus, { type: 'tailData', lines: numbered(21000, 10) });

    await waitFor(() => expect(firstRowText()).toBe('line-10'));
  });

  it('goes back to the limit at once when Auto-scroll is turned on, and clears the selection as before', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 1500) });
    fireEvent.click(await screen.findByText('line-3'));
    expect(selectedRowText()).toBe('line-3');

    fireEvent.click(autoScrollSwitch());
    await waitFor(() => expect(autoScrollSwitch()).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(autoScrollSwitch());
    await waitFor(() => expect(autoScrollSwitch()).toHaveAttribute('aria-checked', 'false'));
    scrollTo(screen.getByRole('list'), 0);

    // The switch clears the selection, as on main; line-3 left with the 500 oldest lines.
    await waitFor(() => expect(firstRowText()).toBe('line-500'));
    expect(selectedRowText()).toBeUndefined();
  });

  it('goes back to the limit when Auto-scroll turns on again at the end of the list (guard: passes on main)', async () => {
    const { vscode } = createVsCodeMock();
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);
    send(bus, { type: 'init', locale: 'en' });
    send(bus, { type: 'tailConfig', tailBufferSize: 1000 });
    send(bus, { type: 'tailData', lines: numbered(0, 1000) });
    await screen.findAllByRole('row');
    const list = screen.getByRole('list');
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });

    scrollTo(list, 300);
    await waitFor(() => expect(autoScrollSwitch()).toHaveAttribute('aria-checked', 'false'));
    send(bus, { type: 'tailData', lines: numbered(1000, 500) });
    scrollTo(list, 800);
    await waitFor(() => expect(autoScrollSwitch()).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(autoScrollSwitch());
    scrollTo(list, 0);
    await waitFor(() => expect(firstRowText()).toBe('line-500'));
  });

  it('keeps up to the new cap when the limit changes while Auto-scroll is off', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 25000) });
    await waitFor(() => expect(firstRowText()).toBe('line-4000'));

    send(bus, { type: 'tailConfig', tailBufferSize: 2000 });
    send(bus, { type: 'tailData', lines: numbered(25000, 2000) });
    await waitFor(() => expect(firstRowText()).toBe('line-5000'));

    send(bus, { type: 'tailConfig', tailBufferSize: 1000 });
    await waitFor(() => expect(firstRowText()).toBe('line-6000'));
  });

  it('empties on a reset while Auto-scroll is off and keeps what comes after it', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 1500) });
    await screen.findByText('line-0');

    send(bus, { type: 'tailReset' });
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    send(bus, { type: 'tailData', lines: numbered(1500, 1200) });

    await waitFor(() => expect(firstRowText()).toBe('line-1500'));
  });

  it('finds an older line beyond the limit with the search while Auto-scroll is off', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 1500) });
    await screen.findByText('line-0');

    fireEvent.change(screen.getByPlaceholderText('Search live logs…'), { target: { value: 'line-12' } });

    await waitFor(() => expect(firstRowText()).toBe('line-12'));
  });

  /** Opens the panel again with the saved state, as the extension does: it sends the last `limit` lines it keeps. */
  function reopen(vscode: VsCodeWebviewApi<WebviewToExtensionMessage>, lines: string[], limit = 1000) {
    const bus = new EventTarget();
    render(<TailApp vscode={vscode} messageBus={bus} />);
    send(bus, { type: 'init', locale: 'en' });
    send(bus, { type: 'tailConfig', tailBufferSize: limit });
    send(bus, { type: 'tailReset' });
    send(bus, { type: 'tailData', lines });
  }

  it('selects the same line after the panel opens again while Auto-scroll is off (guard: passes on main)', async () => {
    const { vscode, bus, view } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: logged(0, 1005) });
    pickLine('line-107');
    view.unmount();

    reopen(vscode, logged(5, 1000));

    await waitFor(() => expect(selectedAmongLines('line-107')).toBe('line-107'));
  });

  /** Shows only `line`, by the search, to tell whether it is the selected line wherever the list is. */
  function selectedAmong(line: string) {
    fireEvent.change(screen.getByPlaceholderText('Search live logs…'), { target: { value: `${line} ` } });
    return selectedRowText();
  }

  for (const strict of [false, true]) {
    const mode = strict ? ' under StrictMode' : '';

    it(`keeps the same line selected when the extension sends its lines again to the open panel while paused${mode} (guard: passes on main)`, async () => {
      const { bus } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines: logged(0, 1005) });
      pickLine('line-107');

      // Replay into the panel kept while hidden: a reset, then the last `limit` lines the extension keeps.
      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines: logged(5, 1000) });

      await waitFor(() => expect(selectedAmongLines('line-107')).toBe('line-107'));
    });

    for (const [where, total] of [
      ['below', 500],
      ['above', 1500]
    ] as const) {
      it(`does not scroll to the selected line when lines arrive while paused ${where} the limit${mode}`, async () => {
        const { bus } = await openPaused(1000, strict);
        send(bus, { type: 'tailData', lines: numbered(0, total) });
        fireEvent.click(await screen.findByText('line-0'));
        const list = screen.getByRole('list');
        scrollTo(list, 4000);
        const writes = spyOnScrollWrites(list);

        send(bus, { type: 'tailData', lines: [`line-${total}`] });
        send(bus, { type: 'tailData', lines: numbered(total + 1, 40) });

        expect(writes()).toBe(0);
      });
    }

    it(`keeps the selected line when the limit rises with older lines kept and the lines come again${mode} (guard: passes on main)`, async () => {
      const { bus } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines: logged(0, 1500) });
      selectedAmong('line-507');
      fireEvent.click(await screen.findByText('line-507'));

      // The extension kept only lines 500 to 1499 under the old limit, and sends those again.
      send(bus, { type: 'tailConfig', tailBufferSize: 2000 });
      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines: logged(500, 1000) });

      await waitFor(() => expect(selectedAmong('line-507')).toBe('line-507'));
    });
  }

  it('keeps the selected line when the limit rises with older lines kept and the panel opens again (guard: passes on main)', async () => {
    const { vscode, bus, view } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: logged(0, 1500) });
    selectedAmong('line-507');
    fireEvent.click(await screen.findByText('line-507'));
    send(bus, { type: 'tailConfig', tailBufferSize: 2000 });
    view.unmount();

    reopen(vscode, logged(500, 1000), 2000);

    await waitFor(() => expect(selectedAmong('line-507')).toBe('line-507'));
  });

  it('keeps a line the extension still has, and selects none it dropped, when the limit falls (guard: passes on main)', async () => {
    for (const [line, expected] of [
      ['line-2507', 'line-2507'],
      ['line-1507', undefined]
    ] as const) {
      const { bus, view } = await openPaused(2000);
      send(bus, { type: 'tailData', lines: logged(0, 3000) });
      selectedAmong(line);
      fireEvent.click(await screen.findByText(line));
      selectedAmong('');

      send(bus, { type: 'tailConfig', tailBufferSize: 1000 });
      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines: logged(2000, 1000) });

      await waitFor(() => expect(screen.queryByText('line-2001')).not.toBeNull());
      expect(selectedAmong(line)).toBe(expected);
      view.unmount();
    }
  });

  it('keeps the selected line in its own log when lines sent again end later, even where another log repeats its text (guard: passes on main)', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const { vscode } = createVsCodeMock({ autoScroll: false });
    const app = { ...vscode, postMessage: (message: WebviewToExtensionMessage) => posted.push(message) };
    const bus = new EventTarget();
    render(<TailApp vscode={app} messageBus={bus} />);
    send(bus, { type: 'init', locale: 'en' });
    send(bus, { type: 'tailConfig', tailBufferSize: 2000 });
    // Every log holds the same lines, as Apex logs of one transaction type do.
    const body = (seq: number) => `body-${seq % 100}`;
    send(bus, { type: 'tailData', lines: logged(0, 1000, body) });
    fireEvent.click((await screen.findAllByText('body-7'))[0]!);

    // A delivery was lost; the session recovers with the extension's lines, which go one log further.
    send(bus, { type: 'tailReset' });
    send(bus, { type: 'tailData', lines: logged(0, 1100, body) });
    fireEvent.click(screen.getByRole('button', { name: 'Open Log' }));

    expect(posted.filter(message => message.type === 'openLog')).toEqual([{ type: 'openLog', logId: 'L0' }]);
  });

  it('saves a new selection of the same line in another log (guard: passes on main)', async () => {
    const posted: WebviewToExtensionMessage[] = [];
    const { vscode } = createVsCodeMock({ autoScroll: false });
    const bus = new EventTarget();
    const view = render(<TailApp vscode={vscode} messageBus={bus} />);
    send(bus, { type: 'init', locale: 'en' });
    send(bus, { type: 'tailConfig', tailBufferSize: 2000 });
    const body = (seq: number) => `body-${seq % 100}.`;
    send(bus, { type: 'tailData', lines: logged(0, 1000, body) });
    const search = screen.getByPlaceholderText('Search live logs…');
    fireEvent.change(search, { target: { value: 'body-7.' } });
    fireEvent.click((await screen.findAllByText('body-7.'))[0]!);
    // Only the log changes: the same text, as far below its header.
    fireEvent.click(screen.getAllByText('body-7.')[1]!);
    view.unmount();

    const app = { ...vscode, postMessage: (message: WebviewToExtensionMessage) => posted.push(message) };
    const nextBus = new EventTarget();
    render(<TailApp vscode={app} messageBus={nextBus} />);
    send(nextBus, { type: 'init', locale: 'en' });
    send(nextBus, { type: 'tailConfig', tailBufferSize: 2000 });
    send(nextBus, { type: 'tailReset' });
    send(nextBus, { type: 'tailData', lines: logged(0, 1000, body) });
    fireEvent.click(screen.getByRole('button', { name: 'Open Log' }));

    expect(posted.filter(message => message.type === 'openLog')).toEqual([{ type: 'openLog', logId: 'L1' }]);
  });

  for (const strict of [false, true]) {
    const mode = strict ? ' under StrictMode' : '';

    it(`keeps the selected log when another log's header has the same hash${mode} (guard: passes on main)`, async () => {
      // These two log ids give the same 32-bit string hash once the rest of the header is the same.
      const lines = ['07L0000009uh896EAA', '07L0000009uftw6EAA'].flatMap(id => [`=== ApexLog ${id} | x`, 'body']);
      const { bus, posted } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines });
      fireEvent.click(screen.getAllByText('body')[1]!);

      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines });

      expect(openLogIds(posted)).toEqual(['07L0000009uftw6EAA']);
    });

    it(`selects nothing when the selected log comes back shorter and the next log is where the line was${mode}`, async () => {
      const log = (id: number, count: number) => [`=== ApexLog L${id} | x`, ...Array<string>(count).fill('same')];
      const { bus, posted } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines: [...log(0, 6), ...log(1, 5)] });
      fireEvent.click(screen.getAllByText('same')[4]!);

      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines: [...log(0, 2), ...log(1, 6)] });

      expect(openLogIds(posted)).toEqual([]);
    });

    it(`does not select again after a reset once Auto-scroll is turned on${mode} (guard: passes on main)`, async () => {
      const { bus, posted, getSavedState } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines: logged(0, 900) });
      pickLine('line-895');

      send(bus, { type: 'tailReset' });
      fireEvent.click(autoScrollSwitch());
      send(bus, { type: 'tailData', lines: logged(0, 900) });

      expect(openLogIds(posted)).toEqual([]);
      expect(getSavedState().selected).toBeUndefined();
    });

    it(`does not select again after Clear${mode}`, async () => {
      const { bus, posted } = await openPaused(1000, strict);
      send(bus, { type: 'tailData', lines: logged(0, 900) });
      pickLine('line-107');

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      send(bus, { type: 'tailReset' });
      send(bus, { type: 'tailData', lines: logged(0, 900) });

      expect(openLogIds(posted)).toEqual([]);
    });
  }

  it('keeps the saved selection when the panel opens twice before the lines come (guard: passes on main)', async () => {
    const { vscode, bus, view } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: logged(0, 1000) });
    pickLine('line-107');
    view.unmount();

    // The panel opens and closes again before the extension sends anything.
    const idle = render(<TailApp vscode={vscode} messageBus={new EventTarget()} />);
    idle.unmount();
    reopen(vscode, logged(0, 1000));

    await waitFor(() => expect(selectedAmongLines('line-107')).toBe('line-107'));
  });

  it('saves no selection once the header of the selected line has left the buffer', async () => {
    const { bus, getSavedState } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: logged(0, 21000) });
    pickLine('line-5');
    expect(getSavedState().selected).toBeDefined();

    send(bus, { type: 'tailData', lines: logged(21000, 1) });

    // Before the search below, which saves the state again on its own.
    expect(getSavedState().selected).toBeUndefined();
    expect(selectedAmongLines('line-5')).toBe('line-5');
  });

  it('scrolls to the selected line when Debug Only is turned off (guard: passes on main)', async () => {
    const { bus } = await openPaused(1000);
    // Every other line is a USER_DEBUG line, so the list keeps rows while Debug Only hides line-500.
    send(bus, { type: 'tailData', lines: numbered(0, 1000).map((line, i) => (i % 2 ? `${line} |USER_DEBUG|` : line)) });
    await screen.findByText('line-0');
    pickLine('line-500');
    let scrolls = 0;
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = () => {
      scrolls++;
    };

    fireEvent.click(screen.getByRole('switch', { name: 'Debug Only' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Debug Only' }));

    Element.prototype.scrollTo = scrollTo;
    expect(scrolls).toBeGreaterThan(0);
  });

  it('numbers the lines after a reset that follows lines in the same task from all lines received (guard: passes on main)', async () => {
    const { bus } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: numbered(0, 900) });
    await screen.findByText('line-0');

    act(() => {
      for (const data of [
        { type: 'tailData', lines: ['line-900'] },
        { type: 'tailReset' },
        { type: 'tailData', lines: ['line-901'] }
      ] as ExtensionToWebviewMessage[]) {
        bus.dispatchEvent(new MessageEvent('message', { data }));
      }
    });

    expect((await screen.findByText('line-901')).closest('[data-line-seq]')?.getAttribute('data-line-seq')).toBe('901');
  });

  it('selects nothing after the panel opens again when the selected line is older than the extension keeps', async () => {
    const { vscode, bus, view } = await openPaused(1000);
    send(bus, { type: 'tailData', lines: logged(0, 1005) });
    fireEvent.click(await screen.findByText('line-2'));
    view.unmount();

    reopen(vscode, logged(5, 1000));

    await screen.findByText('line-5');
    expect(selectedRowText()).toBeUndefined();
  });
});
