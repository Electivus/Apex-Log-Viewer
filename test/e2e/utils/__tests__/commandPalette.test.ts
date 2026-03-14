import { runCommandWhenAvailable } from '../commandPalette';

function createFakePage(noMatchVisibility: boolean[]) {
  const keyboardPress = jest.fn(async () => {});
  const waitForTimeout = jest.fn(async () => {});
  const inputWaitFor = jest.fn(async () => {});
  const inputFill = jest.fn(async () => {});
  const isVisible = jest.fn(async () => noMatchVisibility.shift() ?? false);

  const inputLocator = {
    waitFor: inputWaitFor,
    fill: inputFill
  };

  const widgetLocator = {
    locator: jest.fn((selector: string) => {
      if (selector !== 'input') {
        throw new Error(`Unexpected widget selector: ${selector}`);
      }
      return inputLocator;
    }),
    getByText: jest.fn(() => ({
      isVisible
    }))
  };

  const locator = jest.fn((selector: string) => {
    if (selector === 'div.quick-input-widget input') {
      return inputLocator;
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
    inputWaitFor,
    inputFill,
    isVisible
  };
}

describe('runCommandWhenAvailable', () => {
  test('retries until the command appears and executes from the successful quick-open session', async () => {
    const fake = createFakePage([true, true, false]);

    await runCommandWhenAvailable(fake.page, 'Electivus Apex Logs: Refresh Logs', { timeoutMs: 5_000 });

    expect(fake.inputFill).toHaveBeenNthCalledWith(1, '> Electivus Apex Logs: Refresh Logs');
    expect(fake.inputFill).toHaveBeenNthCalledWith(2, '> Electivus Apex Logs: Refresh Logs');
    expect(fake.inputFill).toHaveBeenNthCalledWith(3, '> Electivus Apex Logs: Refresh Logs');

    const modifierShortcut = process.platform === 'darwin' ? 'Meta+P' : 'Control+P';
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

    expect(fake.inputFill).toHaveBeenCalledWith('> View: Open View...');
  });
});
