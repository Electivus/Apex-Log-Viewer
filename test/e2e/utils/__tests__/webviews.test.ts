import { waitForStablePagePosition, waitForWebviewClickTarget } from '../webviews';

type Box = { x: number; y: number; width: number; height: number } | null;

function targetReading(boxes: Box[]): { boundingBox(): Promise<Box>; reads(): number } {
  let index = 0;
  return {
    async boundingBox() {
      const box = boxes[Math.min(index, boxes.length - 1)] ?? null;
      index += 1;
      return box;
    },
    reads: () => index
  };
}

const bottomPanel = { x: 400, y: 640, width: 60, height: 28 };
const maximizedPanel = { x: 400, y: 120, width: 60, height: 28 };

describe('waitForStablePagePosition', () => {
  test('waits until the box stops moving after a layout change', async () => {
    const target = targetReading([bottomPanel, bottomPanel, maximizedPanel, maximizedPanel, maximizedPanel]);

    await waitForStablePagePosition(target, { intervalMs: 1, stableReads: 3 });

    expect(target.reads()).toBe(5);
  });

  test('ignores sub-pixel differences', async () => {
    const target = targetReading([
      maximizedPanel,
      { ...maximizedPanel, y: maximizedPanel.y + 0.2 },
      { ...maximizedPanel, x: maximizedPanel.x - 0.3 }
    ]);

    await waitForStablePagePosition(target, { intervalMs: 1, stableReads: 3 });

    expect(target.reads()).toBe(3);
  });

  test('does not count reads without a box as stable', async () => {
    const target = targetReading([null, null, null, maximizedPanel, maximizedPanel]);

    await waitForStablePagePosition(target, { intervalMs: 1, stableReads: 2 });

    expect(target.reads()).toBe(5);
  });

  test('fails with the last box when the element keeps moving', async () => {
    let y = 0;
    const moving = {
      async boundingBox() {
        y += 10;
        return { x: 0, y, width: 10, height: 10 };
      }
    };

    await expect(waitForStablePagePosition(moving, { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(
      /did not keep the same position on the page for 3 reads within 30 ms \(last box: 0,\d+,10,10\)/
    );
  });

  test('fails when the element never has a box', async () => {
    const target = targetReading([null]);

    await expect(waitForStablePagePosition(target, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /\(last box: none\)/
    );
  });
});

describe('waitForWebviewClickTarget', () => {
  test('waits for the workbench to draw only after the element stops moving', async () => {
    const calls: string[] = [];
    const boxes: Box[] = [bottomPanel, maximizedPanel, maximizedPanel, maximizedPanel];
    let index = 0;
    const target = {
      async boundingBox() {
        calls.push('box');
        return boxes[Math.min(index++, boxes.length - 1)] ?? null;
      }
    };
    const page = {
      evaluate: jest.fn(async () => {
        calls.push('draw');
      })
    };

    await waitForWebviewClickTarget(page as never, target, { intervalMs: 1 });

    expect(calls).toEqual(['box', 'box', 'box', 'box', 'draw']);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('does not wait for a drawing when the element never settles', async () => {
    let y = 0;
    const moving = {
      async boundingBox() {
        y += 10;
        return { x: 0, y, width: 10, height: 10 };
      }
    };
    const page = { evaluate: jest.fn(async () => undefined) };

    await expect(waitForWebviewClickTarget(page as never, moving, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow(
      /did not keep the same position/
    );
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
