import { runCommandWhenAvailable } from '../commandPalette';

function createFakePage(
  noMatchVisibility: boolean[],
  options?: {
    requireComboboxSelector?: boolean;
  }
) {
  const keyboardPress = jest.fn(async () => {});
  const waitForTimeout = jest.fn(async () => {});
  const strictModeError = new Error('strict mode violation');
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
  const comboboxWaitFor = jest.fn(async () => {});
  const comboboxFill = jest.fn(async () => {});
  const isVisible = jest.fn(async () => noMatchVisibility.shift() ?? false);

  const legacyInputLocator = {
    waitFor: legacyInputWaitFor,
    fill: legacyInputFill
  };

  const comboboxLocator = {
    waitFor: comboboxWaitFor,
    fill: comboboxFill
  };

  const widgetLocator = {
    locator: jest.fn((selector: string) => {
      if (selector !== 'input') {
        throw new Error(`Unexpected widget selector: ${selector}`);
      }
      return legacyInputLocator;
    }),
    getByRole: jest.fn((role: string) => {
      if (role !== 'combobox') {
        throw new Error(`Unexpected widget role: ${role}`);
      }
      return comboboxLocator;
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
      waitForTimeout
    } as any,
    keyboardPress,
    waitForTimeout,
    legacyInputWaitFor,
    legacyInputFill,
    comboboxWaitFor,
    comboboxFill,
    isVisible
  };
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
  });

  test('preserves an explicit command prefix', async () => {
    const fake = createFakePage([false]);

    await runCommandWhenAvailable(fake.page, '> View: Open View...', { timeoutMs: 1_000 });

    expect(fake.comboboxFill).toHaveBeenCalledWith('> View: Open View...');
  });

  test('targets the quick input combobox when a checkbox input is also present', async () => {
    const fake = createFakePage([false], { requireComboboxSelector: true });

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 1_000 });

    expect(fake.comboboxWaitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 15_000 });
    expect(fake.comboboxFill).toHaveBeenCalledWith('> Electivus Apex Logs: Refresh Logs');
  });
});
