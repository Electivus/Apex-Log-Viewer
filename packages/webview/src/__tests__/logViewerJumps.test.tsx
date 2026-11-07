import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { LogViewerFromWebviewMessage, LogViewerToWebviewMessage } from '@alv/protocol/logViewerMessages';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { LogViewerApp } from '../logViewer';

const LIST_HEIGHT = 400;
const TALL_ROW_HEIGHT = 120;
const ONE_LINE_ROW_HEIGHT = 31;

const lines = [
  '65.0 APEX_CODE,DEBUG',
  '14:03:21.5 (1000000)|EXECUTION_STARTED',
  '14:03:21.5 (2000000)|USER_DEBUG|[1]|DEBUG|NEEDLE near the start',
  ...Array.from(
    { length: 200 },
    (_, index) => `14:03:21.6 (${3000000 + index})|USER_DEBUG|[1]|DEBUG|TALL row ${index}`
  ),
  '14:03:21.7 (4000000)|USER_DEBUG|[1]|DEBUG|NEEDLE near the end',
  '14:03:21.9 (185000000)|EXCEPTION_THROWN|[1]|System.MathException: Divide by 0',
  '14:03:21.9 (186000000)|FATAL_ERROR|System.MathException: Divide by 0',
  ...Array.from(
    { length: 20 },
    (_, index) => `14:03:22.0 (${187000000 + index})|USER_DEBUG|[1]|DEBUG|TALL tail ${index}`
  )
];

const logRowOf = (element: HTMLElement): Element | null =>
  element.matches('.log-row') ? element : element.querySelector(':scope > .log-row');

const rowHeightOf = (row: Element): number =>
  row.textContent?.includes('TALL') ? TALL_ROW_HEIGHT : ONE_LINE_ROW_HEIGHT;

const isList = (element: Element): boolean => element.getAttribute('role') === 'list';

const contentHeightOfList = (list: Element): number =>
  parseFloat((list.querySelector(':scope > [aria-hidden="true"]') as HTMLElement | null)?.style.height ?? '0');

const overriddenProperties = ['offsetHeight', 'clientHeight', 'scrollHeight'] as const;

/** jsdom lays nothing out, so this gives the real list the geometry a browser would measure. */
function installLayout() {
  const prototype = HTMLElement.prototype;
  const originals = overriddenProperties.map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)] as const);
  const originalScrollTo = Element.prototype.scrollTo;
  const originalResizeObserver = window.ResizeObserver;

  Object.defineProperty(prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (isList(this)) return LIST_HEIGHT;
      const row = logRowOf(this);
      return row ? rowHeightOf(row) : 0;
    }
  });
  Object.defineProperty(prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isList(this) ? LIST_HEIGHT : 0;
    }
  });
  Object.defineProperty(prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (isList(this)) return contentHeightOfList(this);
      const row = logRowOf(this);
      return row ? rowHeightOf(row) : 0;
    }
  });
  Element.prototype.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number) {
    const top = typeof options === 'object' ? (options.top ?? 0) : 0;
    this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    requestAnimationFrame(() => this.dispatchEvent(new Event('scroll')));
  } as typeof Element.prototype.scrollTo;

  class LayoutResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      requestAnimationFrame(() => {
        if (!target.isConnected) return;
        const height = (target as HTMLElement).offsetHeight;
        const entry = {
          target,
          contentRect: { height, width: 800 },
          borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
          contentBoxSize: [{ blockSize: height, inlineSize: 800 }]
        } as unknown as ResizeObserverEntry;
        this.callback([entry], this);
      });
    }
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = LayoutResizeObserver;

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(prototype, name, descriptor);
      } else {
        delete (prototype as unknown as Record<string, unknown>)[name];
      }
    }
    Element.prototype.scrollTo = originalScrollTo;
    window.ResizeObserver = originalResizeObserver;
  };
}

const entryList = (): HTMLElement => document.querySelector('.log-row')?.closest('[role="list"]') as HTMLElement;

const offsetOf = (row: Element): number =>
  parseFloat(/translateY\((-?[\d.]+)px\)/.exec(row.parentElement?.style.transform ?? '')?.[1] ?? '0');

function rowsInView(): HTMLElement[] {
  const list = entryList();
  return Array.from(list.querySelectorAll<HTMLElement>('.log-row')).filter(row => {
    const top = offsetOf(row) - list.scrollTop;
    return top + rowHeightOf(row) > 0 && top < LIST_HEIGHT;
  });
}

/** Waits out the rows being measured after a jump. An entry can be in view for a moment and then get pushed out. */
async function waitForListToSettle() {
  let last = '';
  let stillFrames = 0;
  while (stillFrames < 10) {
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    const list = entryList();
    const current = JSON.stringify([list.scrollTop, contentHeightOfList(list), rowsInView().map(offsetOf)]);
    stillFrames = current === last ? stillFrames + 1 : 0;
    last = current;
  }
}

async function expectInView(rowClass: string, text: string) {
  await waitForListToSettle();
  const inView = rowsInView().map(
    row => `${row.classList.contains(rowClass) ? 'marked' : 'other'}: ${row.textContent}`
  );
  expect(inView).toContainEqual(expect.stringMatching(new RegExp(`^marked: .*${text}`)));
}

function openLog() {
  const vscode: VsCodeWebviewApi<LogViewerFromWebviewMessage> = {
    postMessage: () => {},
    getState: () => undefined,
    setState: () => {}
  };
  const bus = new EventTarget();
  render(<LogViewerApp vscode={vscode} messageBus={bus} />);
  const send = (message: LogViewerToWebviewMessage) =>
    act(() => {
      bus.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  send({ type: 'logViewerInit', logId: 'long-log', locale: 'en-US', fileName: 'long.log', lines });
  return send;
}

describe('Log Viewer jumps in a long log with tall rows', () => {
  let uninstallLayout: () => void;

  beforeEach(() => {
    uninstallLayout = installLayout();
  });

  afterEach(() => {
    uninstallLayout();
  });

  it('brings the failed entry into view with one click on Go to error', async () => {
    openLog();
    const banner = await screen.findByRole('alert', { name: 'Failure' });
    await waitForListToSettle();

    fireEvent.click(within(banner).getByRole('button', { name: 'Go to error' }));

    await expectInView('log-selected', 'FATAL_ERROR');
  });

  it('brings the entry into view with one click on a sidebar diagnostic', async () => {
    const send = openLog();
    await screen.findByRole('alert', { name: 'Failure' });
    send({
      type: 'logViewerTriageUpdate',
      logId: 'long-log',
      triage: {
        hasErrors: true,
        reasons: [
          {
            code: 'fatal_exception',
            severity: 'error',
            summary: 'Fatal exception',
            line: 1,
            eventType: 'EXCEPTION_THROWN'
          }
        ]
      }
    });
    await waitForListToSettle();

    const sidebar = screen.getByText('Diagnostics').closest('aside') as HTMLElement;
    fireEvent.click(within(sidebar).getByRole('button', { name: /Divide by 0/ }));

    await expectInView('log-selected', 'EXCEPTION_THROWN');
  });

  it('brings the last match into view when Previous match wraps from the first', async () => {
    openLog();
    await screen.findByRole('alert', { name: 'Failure' });
    fireEvent.change(screen.getByPlaceholderText('Search entries…'), { target: { value: 'NEEDLE' } });
    await screen.findByText('1/2');
    await waitForListToSettle();

    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));

    await screen.findByText('2/2');
    await expectInView('log-row-active-match', 'NEEDLE near the end');
  });
});
