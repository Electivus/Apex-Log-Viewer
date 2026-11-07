import { openView, runCommand, runCommandWhenAvailable, waitForCommandAvailable } from '../commandPalette';

const QUICK_ACCESS_ROWS = ['Go to File', 'Show and Run Commands', 'Search for Text'];
const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';

interface FakeInputLocator {
  waitFor: (...args: any[]) => Promise<void>;
  fill: (...args: any[]) => Promise<void>;
  inputValue: () => Promise<string>;
}

function createComposableLocator(...delegates: FakeInputLocator[]) {
  return {
    waitFor: async (...args: any[]) => {
      let lastError: unknown;
      for (const delegate of delegates) {
        try {
          await delegate.waitFor(...args);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    fill: async (...args: any[]) => {
      let lastError: unknown;
      for (const delegate of delegates) {
        try {
          await delegate.fill(...args);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    inputValue: async () => {
      let lastError: unknown;
      for (const delegate of delegates) {
        try {
          return await delegate.inputValue();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    or(other: FakeInputLocator) {
      return createComposableLocator(...delegates, other);
    },
    first() {
      return this;
    }
  };
}

function createFakePage(
  noMatchVisibility: boolean[],
  options?: {
    requireComboboxSelector?: boolean;
    requireTextboxFallback?: boolean;
    keyboardShortcutMissesQuickInput?: boolean;
    quickInputWaitFailuresBeforeVisible?: number;
    quickAccessClickError?: Error;
    typedTextIsLost?: boolean;
    closesAfterFill?: boolean;
    /** Rows the palette lists for a query, as a label or a translated label with its English alias; by default only the queried label. */
    labelsFor?: (query: string) => Array<string | { label: string; alias: string }>;
  }
) {
  let lastQuery = '';
  let focusedIndex = 0;
  const filled: string[] = [];
  const executed: string[] = [];
  const labelsFor = options?.labelsFor ?? ((query: string) => [query.replace(/^>\s*/, '')]);
  const currentRows = () =>
    labelsFor(lastQuery).map(row => (typeof row === 'string' ? { label: row, alias: '' } : row));
  const currentLabels = () => currentRows().map(row => row.label);
  const keyboardPress = jest.fn(async (key: string) => {
    if (key === 'ArrowDown') {
      focusedIndex = Math.min(focusedIndex + 1, currentLabels().length - 1);
    } else if (key === 'ArrowUp') {
      focusedIndex = Math.max(focusedIndex - 1, 0);
    } else if (key === 'Enter') {
      executed.push(currentLabels()[focusedIndex] ?? '');
    }
  });
  const recordFill = (value: string) => {
    if (options?.typedTextIsLost) {
      return;
    }
    lastQuery = value;
    focusedIndex = 0;
    filled.push(value);
  };
  const inputValue = jest.fn(async () => {
    if (options?.closesAfterFill) {
      throw new Error('Timed out reading the quick input');
    }
    return lastQuery;
  });
  const readRows = jest.fn(async () =>
    currentRows().map((row, index) => ({ index, ...row, focused: index === focusedIndex }))
  );
  // A virtual clock: each wait advances Date.now, so the helpers' deadlines pass without real waiting.
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const waitForTimeout = jest.fn(async (ms: number) => {
    now += ms;
  });
  const strictModeError = new Error('strict mode violation');
  const quickInputMissingError = new Error('Timed out waiting for quick input');
  let quickInputVisible = !options?.keyboardShortcutMissesQuickInput;
  let quickInputWaitFailuresBeforeVisible = options?.quickInputWaitFailuresBeforeVisible ?? 0;
  const legacyInputWaitFor = jest.fn(async () => {
    if (options?.requireComboboxSelector) {
      throw strictModeError;
    }
  });
  const legacyInputFill = jest.fn(async () => {
    if (options?.requireComboboxSelector) {
      throw strictModeError;
    }
  });
  const comboboxWaitFor = jest.fn(async () => {
    if (quickInputWaitFailuresBeforeVisible > 0) {
      quickInputWaitFailuresBeforeVisible -= 1;
      throw quickInputMissingError;
    }
    if (!quickInputVisible) {
      throw quickInputMissingError;
    }
  });
  const comboboxFill = jest.fn(async (value: string) => recordFill(value));
  const textboxWaitFor = jest.fn(async () => {
    if (quickInputWaitFailuresBeforeVisible > 0) {
      quickInputWaitFailuresBeforeVisible -= 1;
      throw quickInputMissingError;
    }
    if (!quickInputVisible) {
      throw quickInputMissingError;
    }
  });
  const textboxFill = jest.fn(async (value: string) => recordFill(value));
  const isVisible = jest.fn(async () => noMatchVisibility.shift() ?? false);
  const quickAccessClick = jest.fn(async (_options?: { timeout?: number }) => {
    if (options?.quickAccessClickError) {
      throw options.quickAccessClickError;
    }
    quickInputVisible = true;
  });
  const getByRole = jest.fn((role: string, roleOptions?: { name?: string | RegExp }) => {
    if (role === 'button' && roleOptions?.name instanceof RegExp && roleOptions.name.test('Open Quick Access')) {
      return {
        click: quickAccessClick
      };
    }
    throw new Error(`Unexpected page role: ${role}`);
  });

  const legacyInputLocator = {
    waitFor: legacyInputWaitFor,
    fill: legacyInputFill,
    inputValue
  };

  const comboboxLocator = {
    waitFor: comboboxWaitFor,
    fill: comboboxFill,
    inputValue
  };

  const textboxLocator = {
    waitFor: textboxWaitFor,
    fill: textboxFill,
    inputValue
  };

  const widgetLocator = {
    locator: jest.fn((selector: string) => {
      if (selector === '.monaco-list-row') {
        return { evaluateAll: readRows };
      }
      if (selector !== 'input') {
        throw new Error(`Unexpected widget selector: ${selector}`);
      }
      return createComposableLocator(legacyInputLocator);
    }),
    getByRole: jest.fn((role: string) => {
      if (role === 'combobox') {
        if (options?.requireTextboxFallback) {
          return createComposableLocator({
            waitFor: jest.fn(async () => {
              throw strictModeError;
            }),
            fill: jest.fn(async () => {
              throw strictModeError;
            }),
            inputValue: jest.fn(async () => {
              throw strictModeError;
            })
          });
        }
        return createComposableLocator(comboboxLocator);
      }
      if (role === 'textbox') {
        return createComposableLocator(textboxLocator);
      }
      throw new Error(`Unexpected widget role: ${role}`);
    }),
    getByText: jest.fn(() => ({
      isVisible
    }))
  };

  const locator = jest.fn((selector: string) => {
    if (selector === 'div.quick-input-widget input') {
      return legacyInputLocator;
    }
    if (selector === 'div.quick-input-widget') {
      return widgetLocator;
    }
    throw new Error(`Unexpected selector: ${selector}`);
  });

  return {
    page: {
      keyboard: { press: keyboardPress },
      locator,
      getByRole,
      waitForTimeout
    } as any,
    keyboardPress,
    waitForTimeout,
    getByRole,
    quickAccessClick,
    legacyInputWaitFor,
    legacyInputFill,
    comboboxWaitFor,
    comboboxFill,
    textboxWaitFor,
    textboxFill,
    isVisible,
    readRows,
    filled,
    executed
  };
}

function expectBriefQuickInputWait(waitFor: jest.Mock): void {
  expect(waitFor).toHaveBeenCalled();
  const firstCallOptions = waitFor.mock.calls[0][0];
  expect(firstCallOptions).toMatchObject({ state: 'visible' });
  expect(firstCallOptions.timeout).toBeGreaterThan(0);
  expect(firstCallOptions.timeout).toBeLessThan(15_000);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runCommandWhenAvailable', () => {
  test('retries until the command appears and executes from the successful command-palette session', async () => {
    const fake = createFakePage([true, true, false]);

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 5_000 });

    expect(fake.comboboxFill).toHaveBeenNthCalledWith(1, '> Electivus Apex Logs: Refresh Logs');
    expect(fake.comboboxFill).toHaveBeenNthCalledWith(2, '> Electivus Apex Logs: Refresh Logs');
    expect(fake.comboboxFill).toHaveBeenNthCalledWith(3, '> Electivus Apex Logs: Refresh Logs');

    const modifierShortcut = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
    expect(fake.keyboardPress.mock.calls.map(call => call[0])).toEqual([
      modifierShortcut,
      'Escape',
      modifierShortcut,
      'Escape',
      modifierShortcut,
      'Enter'
    ]);
    expect(fake.waitForTimeout.mock.calls.map(call => call[0])).toEqual([50, 500, 50, 500, 50, 50]);
    expect(fake.executed).toEqual(['Electivus Apex Logs: Refresh Logs']);
    expectBriefQuickInputWait(fake.comboboxWaitFor);
  });

  test('preserves an explicit command prefix', async () => {
    const fake = createFakePage([false]);

    await runCommandWhenAvailable(fake.page, '> View: Open View...', { timeoutMs: 1_000 });

    expect(fake.comboboxFill).toHaveBeenCalledWith('> View: Open View...');
  });

  test('targets the quick input combobox when a checkbox input is also present', async () => {
    const fake = createFakePage([false], { requireComboboxSelector: true });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expectBriefQuickInputWait(fake.comboboxWaitFor);
    expect(fake.comboboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });

  test('falls back to the quick input textbox when the command palette does not expose a combobox role', async () => {
    const fake = createFakePage([false], { requireTextboxFallback: true });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expectBriefQuickInputWait(fake.textboxWaitFor);
    expect(fake.textboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });

  test('clicks Open Quick Access when the keyboard shortcut does not reveal quick input', async () => {
    const fake = createFakePage([false], { keyboardShortcutMissesQuickInput: true });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expectBriefQuickInputWait(fake.comboboxWaitFor);
    expect(fake.getByRole).toHaveBeenCalledWith('button', { name: /Open Quick Access/i });
    expect(fake.quickAccessClick).toHaveBeenCalledWith({ timeout: expect.any(Number) });
    expect(fake.quickAccessClick.mock.calls[0]?.[0]?.timeout).toBeGreaterThan(0);
    expect(fake.quickAccessClick.mock.calls[0]?.[0]?.timeout).toBeLessThan(15_000);
    expect(fake.comboboxWaitFor).toHaveBeenLastCalledWith({ state: 'visible', timeout: 15_000 });
    expect(fake.comboboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });

  test('continues waiting for delayed shortcut quick input when Open Quick Access is missing or renamed', async () => {
    const fake = createFakePage([false], {
      quickInputWaitFailuresBeforeVisible: 2,
      quickAccessClickError: new Error('Open Quick Access button not found')
    });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expect(fake.getByRole).toHaveBeenCalledWith('button', { name: /Open Quick Access/i });
    expect(fake.quickAccessClick).toHaveBeenCalledWith({ timeout: expect.any(Number) });
    expect(fake.comboboxWaitFor).toHaveBeenNthCalledWith(1, { state: 'visible', timeout: expect.any(Number) });
    expect(fake.comboboxWaitFor).toHaveBeenLastCalledWith({ state: 'visible', timeout: 15_000 });
    expect(fake.comboboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });

  test('runs the exact command when the palette lists a longer label first', async () => {
    const fake = createFakePage([false], {
      labelsFor: () => ['Electivus Apex Logs: Refresh Custom Logs', 'Electivus Apex Logs: Refresh Logs']
    });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expect(fake.executed).toEqual(['Electivus Apex Logs: Refresh Logs']);
    expect(fake.keyboardPress.mock.calls.map(call => call[0]).slice(-2)).toEqual(['ArrowDown', 'Enter']);
  });

  test('keeps waiting while the palette lists only other commands', async () => {
    const fake = createFakePage([false, false], {
      labelsFor: () => ['Electivus Apex Logs: Refresh Custom Logs']
    });

    await expect(
      runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1 })
    ).rejects.toThrow(
      'Timed out waiting for command to appear in palette: "Electivus Apex Logs: Refresh Logs"; the palette last listed "Electivus Apex Logs: Refresh Custom Logs"'
    );
    expect(fake.executed).toEqual([]);
  });
});

describe('runCommand', () => {
  test('moves to the row labelled exactly as requested before pressing Enter', async () => {
    const fake = createFakePage([false], {
      labelsFor: () => [
        'View: Close All Editor Groups',
        'View: Close All Editors',
        'View: Close All Editors in Group',
        'View: Close Editor'
      ]
    });

    await runCommand(fake.page, 'View: Close Editor');

    expect(fake.executed).toEqual(['View: Close Editor']);
    expect(fake.keyboardPress.mock.calls.map(call => call[0]).slice(1)).toEqual([
      'ArrowDown',
      'ArrowDown',
      'ArrowDown',
      'Enter'
    ]);
  });

  test('finds the command by its English title when VS Code shows a translated one', async () => {
    const fake = createFakePage([false], {
      labelsFor: () => [
        { label: 'Exibir: Fechar Todos os Grupos de Editores', alias: 'View: Close All Editor Groups' },
        { label: 'Exibir: Fechar Editor', alias: 'View: Close Editor' },
        'Electivus Apex Logs: Show Extension Output'
      ]
    });

    await runCommand(fake.page, 'View: Close Editor');

    expect(fake.executed).toEqual(['Exibir: Fechar Editor']);
  });

  test('presses Enter at once when the first row is the requested command', async () => {
    const fake = createFakePage([false], {
      labelsFor: () => ['View: Toggle Maximized Panel', 'View: Toggle Maximized Secondary Side Bar']
    });

    await runCommand(fake.page, 'View: Toggle Maximized Panel');

    expect(fake.executed).toEqual(['View: Toggle Maximized Panel']);
    expect(fake.keyboardPress.mock.calls.map(call => call[0]).slice(1)).toEqual(['Enter']);
  });

  test('fails without running anything when no row has the exact label', async () => {
    const fake = createFakePage([false], {
      labelsFor: () => ['Clear Command History', 'Terminal: Copy Last Command']
    });

    await expect(runCommand(fake.page, 'Developer: Execute Command...')).rejects.toThrow(
      'No palette row is labelled exactly "Developer: Execute Command..."; the palette listed "Clear Command History", "Terminal: Copy Last Command"'
    );
    expect(fake.executed).toEqual([]);
    expect(fake.keyboardPress.mock.calls.map(call => call[0]).slice(-1)).toEqual(['Escape']);
  });
});

describe('a window that has stopped taking keyboard input', () => {
  const lostKeys = (query: string) =>
    `Keys are not reaching VS Code: ${PALETTE_SHORTCUT} and the typed query were lost, so the palette input holds "" instead of "${query}".`;

  test('runCommand names the lost shortcut when it opened Quick Access through the button', async () => {
    const fake = createFakePage([false], {
      keyboardShortcutMissesQuickInput: true,
      typedTextIsLost: true,
      labelsFor: () => QUICK_ACCESS_ROWS
    });

    await expect(runCommand(fake.page, 'View: Close Editor')).rejects.toThrow(
      `${lostKeys('> View: Close Editor')} No palette row is labelled exactly "View: Close Editor"; the palette listed "Go to File", "Show and Run Commands", "Search for Text"`
    );
    expect(fake.executed).toEqual([]);
  });

  test('runCommand names the lost shortcut when an earlier failure left the palette open', async () => {
    const fake = createFakePage([false], { typedTextIsLost: true, labelsFor: () => QUICK_ACCESS_ROWS });

    await expect(runCommand(fake.page, 'View: Close Editor')).rejects.toThrow(lostKeys('> View: Close Editor'));
    expect(fake.quickAccessClick).not.toHaveBeenCalled();
  });

  test('runCommandWhenAvailable names the lost shortcut when it times out', async () => {
    const fake = createFakePage([false, false], { typedTextIsLost: true, labelsFor: () => QUICK_ACCESS_ROWS });

    await expect(
      runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1 })
    ).rejects.toThrow(
      `${lostKeys('> Electivus Apex Logs: Refresh Logs')} Timed out waiting for command to appear in palette: "Electivus Apex Logs: Refresh Logs"`
    );
  });

  test('waitForCommandAvailable names the lost shortcut when it times out', async () => {
    const fake = createFakePage([false, false], { typedTextIsLost: true, labelsFor: () => QUICK_ACCESS_ROWS });

    await expect(
      waitForCommandAvailable(fake.page, 'Electivus Apex Logs: Tail Logs', { timeoutMs: 1 })
    ).rejects.toThrow(
      `${lostKeys('> Electivus Apex Logs: Tail Logs')} Timed out waiting for command to appear in palette: "Electivus Apex Logs: Tail Logs"`
    );
  });

  test('names the shortcut when neither it nor the button opens the palette', async () => {
    const fake = createFakePage([false], {
      keyboardShortcutMissesQuickInput: true,
      quickAccessClickError: new Error('Open Quick Access button not found')
    });

    await expect(runCommand(fake.page, 'View: Close Editor')).rejects.toThrow(
      `Neither ${PALETTE_SHORTCUT} nor the Open Quick Access button opened the palette`
    );
  });

  test('blames the palette contents when the query reached the input through the button', async () => {
    const fake = createFakePage([false], {
      keyboardShortcutMissesQuickInput: true,
      labelsFor: () => ['Clear Command History']
    });

    await expect(runCommand(fake.page, 'View: Close Editor')).rejects.toThrow(
      /^No palette row is labelled exactly "View: Close Editor"; the palette listed "Clear Command History"$/
    );
  });

  test('makes no claim about keys when the palette closed before its input could be read', async () => {
    const fake = createFakePage([false], { closesAfterFill: true, labelsFor: () => ['Clear Command History'] });

    await expect(runCommand(fake.page, 'View: Close Editor')).rejects.toThrow(
      /^No palette row is labelled exactly "View: Close Editor"; the palette listed "Clear Command History"$/
    );
  });

  test('still runs the command when the button opened the palette and the query reached the input', async () => {
    const fake = createFakePage([false], { keyboardShortcutMissesQuickInput: true });

    await runCommand(fake.page, 'View: Close Editor');

    expect(fake.executed).toEqual(['View: Close Editor']);
  });
});

describe('waitForCommandAvailable', () => {
  test('returns once the exact label is listed and runs nothing', async () => {
    const fake = createFakePage([false]);

    await waitForCommandAvailable(fake.page, 'Electivus Apex Logs: Tail Logs', { timeoutMs: 1_000 });

    expect(fake.executed).toEqual([]);
    expect(fake.keyboardPress.mock.calls.map(call => call[0]).slice(-1)).toEqual(['Escape']);
  });
});

describe('openView', () => {
  test('keeps the picker prefix and opens the view named exactly as requested', async () => {
    const fake = createFakePage([false], {
      labelsFor: query =>
        query.startsWith('view ')
          ? ['Apex Logs', 'Apex Tail', 'Apex Tail']
          : [query.replace(/^>\s*/, '')]
    });

    await openView(fake.page, 'Apex Tail');

    expect(fake.filled).toEqual(['> View: Open View', 'view Apex Tail']);
    expect(fake.executed).toEqual(['View: Open View', 'Apex Tail']);
  });
});
