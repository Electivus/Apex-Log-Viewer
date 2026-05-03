import { runCommandWhenAvailable } from '../commandPalette';

function createComposableLocator(...delegates: Array<{ waitFor: (...args: any[]) => Promise<void>; fill: (...args: any[]) => Promise<void> }>) {
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
    or(other: { waitFor: (...args: any[]) => Promise<void>; fill: (...args: any[]) => Promise<void> }) {
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
  }
) {
  const keyboardPress = jest.fn(async () => {});
  const waitForTimeout = jest.fn(async () => {});
  const strictModeError = new Error('strict mode violation');
  const quickInputMissingError = new Error('Timed out waiting for quick input');
  let quickInputVisible = !options?.keyboardShortcutMissesQuickInput;
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
    if (!quickInputVisible) {
      throw quickInputMissingError;
    }
  });
  const comboboxFill = jest.fn(async () => {});
  const textboxWaitFor = jest.fn(async () => {
    if (!quickInputVisible) {
      throw quickInputMissingError;
    }
  });
  const textboxFill = jest.fn(async () => {});
  const isVisible = jest.fn(async () => noMatchVisibility.shift() ?? false);
  const quickAccessClick = jest.fn(async () => {
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
    fill: legacyInputFill
  };

  const comboboxLocator = {
    waitFor: comboboxWaitFor,
    fill: comboboxFill
  };

  const textboxLocator = {
    waitFor: textboxWaitFor,
    fill: textboxFill
  };

  const widgetLocator = {
    locator: jest.fn((selector: string) => {
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
    isVisible
  };
}

function expectBriefQuickInputWait(waitFor: jest.Mock): void {
  expect(waitFor).toHaveBeenCalled();
  const firstCallOptions = waitFor.mock.calls[0][0];
  expect(firstCallOptions).toMatchObject({ state: 'visible' });
  expect(firstCallOptions.timeout).toBeGreaterThan(0);
  expect(firstCallOptions.timeout).toBeLessThan(15_000);
}

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
    expect(fake.waitForTimeout.mock.calls.map(call => call[0])).toEqual([50, 500, 50, 500, 50]);
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
    expect(fake.quickAccessClick).toHaveBeenCalledTimes(1);
    expect(fake.comboboxWaitFor).toHaveBeenLastCalledWith({ state: 'visible', timeout: 15_000 });
    expect(fake.comboboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });
});
