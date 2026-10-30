import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { CustomLogsFromWebviewMessage, CustomLogsToWebviewMessage } from '@alv/protocol/customLogsMessages';
import type {
  CustomLogPayloadField,
  CustomLogPayloadView,
  CustomLogRow,
  CustomLogScalar,
  CustomLogSourceView
} from '@alv/protocol/customLogsTypes';
import type { VsCodeWebviewApi } from '../vscodeApi';
import { CustomLogsApp } from '../customLogs';

export function parsed(
  values: Record<string, CustomLogScalar>,
  extra: Partial<Extract<CustomLogPayloadView, { state: 'parsed' }>> = {}
): CustomLogPayloadView {
  return { state: 'parsed', values, droppedPaths: 0, cutValues: [], ...extra };
}

export function makeRow(id: string, title: string, overrides: Partial<CustomLogRow> = {}): CustomLogRow {
  return {
    id,
    time: '2026-10-29T23:41:07.000Z',
    title,
    user: 'integration@acme.com',
    level: 'INFO',
    extra: { Category__c: 'Orders' },
    ...overrides
  };
}

export const ids = {
  failed: 'a0B5g00000Zt1QwEAJ',
  retry: 'a0B5g00000Zt1QvEAJ',
  ok: 'a0B5g00000Zt1QuEAJ',
  legacy: 'a0B5g00000Zt1QtEAJ',
  invalid: 'a0B5g00000Zt1QsEAJ',
  text: 'a0B5g00000Zt1QrEAJ',
  empty: 'a0B5g00000Zt1QqEAJ',
  hidden: 'a0B5g00000Zt1QpEAJ'
};

export const rows: CustomLogRow[] = [
  makeRow(ids.failed, 'Order sync failed', {
    level: 'ERROR',
    payload: parsed(
      {
        orderId: 'ORD-1042',
        'http.status': 502,
        'http.body': 'Bad gateway',
        'tags[0]': 'vip',
        'tags[1]': 'beta',
        'lines[0].sku': 'SKU-1'
      },
      { cutValues: ['http.body'] }
    )
  }),
  makeRow(ids.retry, 'Retrying order sync', {
    level: 'WARN',
    payload: parsed({ orderId: 'ORD-1042', 'http.status': 429, 'tags[0]': 'beta' })
  }),
  makeRow(ids.ok, 'Order synced', { payload: parsed({ orderId: 'ORD-1043', 'http.status': 200 }) }),
  makeRow(ids.legacy, 'Legacy status as text', { payload: parsed({ orderId: 'ORD-1044', 'http.status': '500' }) }),
  makeRow(ids.invalid, 'Broken json payload', { payload: { state: 'invalid' } }),
  makeRow(ids.text, 'Free text payload', { payload: { state: 'text' } }),
  makeRow(ids.empty, 'Empty payload', { payload: { state: 'empty' } }),
  makeRow(ids.hidden, 'Hidden payload', { payload: { state: 'hidden' } })
];

export const payloadFields: CustomLogPayloadField[] = [
  { path: 'orderId', types: ['string'], rows: 4 },
  { path: 'http.status', types: ['number', 'string'], rows: 4 },
  { path: 'http.body', types: ['string'], rows: 1 },
  { path: 'lines[0].sku', types: ['string'], rows: 1 },
  { path: 'tags[0]', types: ['string'], rows: 2 },
  { path: 'tags[1]', types: ['string'], rows: 1 }
];

export const appLog: CustomLogSourceView = {
  id: 'app-log',
  label: 'App Log',
  origin: 'config',
  shape: 'entries',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: false },
  payload: { entry: { field: 'Payload__c', columns: ['orderId'] } },
  state: 'ready'
};

export const nebula: CustomLogSourceView = {
  id: 'nebula',
  label: 'Nebula Logger',
  origin: 'builtin',
  shape: 'transactions',
  hiddenFields: [],
  capabilities: { levelFilter: true, userFilter: true, apexLogLink: true },
  payload: {},
  state: 'ready'
};

export function createVsCodeMock(initialState?: unknown) {
  const posted: CustomLogsFromWebviewMessage[] = [];
  let savedState = initialState;
  const vscode: VsCodeWebviewApi<CustomLogsFromWebviewMessage> = {
    postMessage: msg => {
      posted.push(msg);
    },
    getState: () => savedState as any,
    setState: state => {
      savedState = state;
    }
  };
  return { vscode, posted, getSavedState: () => savedState };
}

export function send(bus: EventTarget, message: CustomLogsToWebviewMessage) {
  act(() => {
    bus.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

export type BootstrapOptions = {
  sources?: CustomLogSourceView[];
  selected?: string;
  issues?: Array<{ severity: 'error' | 'warning'; pointer: string; message: string }>;
  rows?: CustomLogRow[];
  fields?: CustomLogPayloadField[];
  defaults?: string[];
  added?: string[];
  hasMore?: boolean;
  surface?: 'view' | 'editor';
};

export function mountApp(options: BootstrapOptions = {}, initialState?: unknown) {
  const mock = createVsCodeMock(initialState);
  const bus = new EventTarget();
  const view = render(<CustomLogsApp vscode={mock.vscode} messageBus={bus} />);
  send(bus, { type: 'customLogsInit', locale: 'en', surface: options.surface });
  send(bus, { type: 'customLogsOrgs', data: [{ username: 'dev@acme.com', alias: 'acme-dev' }], selected: 'dev@acme.com' });
  send(bus, {
    type: 'customLogsSources',
    data: options.sources ?? [appLog],
    selected: options.selected ?? options.sources?.[0]?.id ?? 'app-log',
    issues: options.issues ?? []
  });
  send(bus, { type: 'customLogsFilter', value: {} });
  send(bus, { type: 'customLogsPayloadColumns', value: { defaults: options.defaults ?? [], added: options.added ?? [] } });
  send(bus, {
    type: 'customLogsPage',
    mode: 'replace',
    columns: [{ key: 'Category__c', label: 'Category' }],
    rows: options.rows ?? rows,
    payloadFields: options.fields ?? payloadFields,
    hasMore: options.hasMore ?? false
  });
  return { ...mock, bus, view };
}

export const filterInput = () => screen.getByRole('combobox', { name: 'Filter logs' });
export const grid = () => screen.getByRole('grid', { name: 'Custom logs' });
export const listedTitles = () =>
  Array.from(grid().querySelectorAll('[data-row-id]')).map(row => row.querySelector('[role="gridcell"]:nth-child(3)')?.textContent?.trim());
export const chips = () => screen.queryAllByTestId('filter-chip');
export const chipSummary = () => chips().map(chip => [chip.getAttribute('data-scope'), chip.textContent]);
export const columnHeader = (name: string) =>
  screen.getAllByRole('columnheader').find(header => header.querySelector('button span.truncate')?.textContent === name)!;
export const headerLabels = () =>
  screen
    .getAllByRole('columnheader')
    .map(header => header.querySelector('button span.truncate')?.textContent)
    .filter(Boolean);
export const rowOf = (id: string) => grid().querySelector(`[data-row-id="${id}"]`) as HTMLElement;

export function submit(text: string) {
  fireEvent.change(filterInput(), { target: { value: text } });
  fireEvent.keyDown(filterInput(), { key: 'Enter' });
}

export function posts<T extends CustomLogsFromWebviewMessage['type']>(posted: CustomLogsFromWebviewMessage[], type: T) {
  return posted.filter((message): message is Extract<CustomLogsFromWebviewMessage, { type: T }> => message.type === type);
}

export function lastPost<T extends CustomLogsFromWebviewMessage['type']>(posted: CustomLogsFromWebviewMessage[], type: T) {
  return posts(posted, type).at(-1);
}

export function removeMountSequenceMeta() {
  document.head.querySelectorAll('meta[name="alv-mount-sequence"]').forEach(meta => meta.remove());
}
