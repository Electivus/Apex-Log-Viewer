/**
 * The list surface's screen as data: what the provider keeps as its replay snapshot and what the
 * webview renders. Both fold the same outbound messages through `reduceCustomLogsView`, so the append
 * rule and "not received yet" live here once, and `replayCustomLogsView` turns the state back into the
 * messages that rebuild it after a remount. Reducing a replay from empty gives the same state.
 */

import type { CustomLogsToWebviewMessage } from './customLogsMessages.js';
import {
  mergeLiveRows,
  mergePayloadFields,
  type CustomLogCaptureView,
  type CustomLogColumn,
  type CustomLogConfigIssueView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceView,
  type CustomLogsFilterView
} from './customLogsTypes.js';
import type { OrgItem } from './types.js';

export type CustomLogsViewState = {
  /** Undefined until the host sends `customLogsInit`. */
  locale: string | undefined;
  surface: 'view' | 'editor';
  /** Undefined until the host sends the orgs, so the webview can tell "not asked yet" from "no orgs". */
  orgs: { data: OrgItem[]; selected: string | undefined } | undefined;
  sources:
    { data: CustomLogSourceView[]; selected: string | undefined; issues: CustomLogConfigIssueView[] } | undefined;
  filter: CustomLogsFilterView;
  payloadColumns: CustomLogPayloadColumnsView;
  /** Every loaded row, its columns and the payload fields merged across pages. */
  page:
    | { columns: CustomLogColumn[]; rows: CustomLogRow[]; payloadFields: CustomLogPayloadField[]; hasMore: boolean }
    | undefined;
  /** The capture strip. Undefined while the selected source is not an event source. */
  capture: CustomLogCaptureView | undefined;
  loading: boolean;
  error: string | undefined;
};

export const initialCustomLogsView: CustomLogsViewState = {
  locale: undefined,
  surface: 'view',
  orgs: undefined,
  sources: undefined,
  filter: {},
  payloadColumns: { defaults: [], added: [] },
  page: undefined,
  capture: undefined,
  loading: false,
  error: undefined
};

export function reduceCustomLogsView(
  state: CustomLogsViewState,
  message: CustomLogsToWebviewMessage
): CustomLogsViewState {
  switch (message.type) {
    case 'customLogsInit':
      return { ...state, locale: message.locale, surface: message.surface ?? 'view' };
    case 'customLogsOrgs':
      return { ...state, orgs: { data: [...(message.data ?? [])], selected: message.selected } };
    case 'customLogsSources':
      return {
        ...state,
        sources: { data: [...(message.data ?? [])], selected: message.selected, issues: [...(message.issues ?? [])] }
      };
    case 'customLogsFilter':
      return { ...state, filter: message.value ?? {} };
    case 'customLogsPayloadColumns':
      return { ...state, payloadColumns: message.value ?? initialCustomLogsView.payloadColumns };
    case 'customLogsLoading':
      return { ...state, loading: !!message.value };
    case 'customLogsPage': {
      const rows = message.rows ?? [];
      const payloadFields = message.payloadFields ?? [];
      const loaded = message.mode === 'append' ? state.page : undefined;
      return {
        ...state,
        page: {
          columns: message.columns ?? [],
          rows: loaded ? [...loaded.rows, ...rows] : [...rows],
          payloadFields: mergePayloadFields(loaded?.payloadFields ?? [], payloadFields),
          hasMore: !!message.hasMore
        }
      };
    }
    case 'customLogsCapture':
      return { ...state, capture: message.value };
    case 'customLogsLiveRows': {
      // Rows that arrive before the first page are on disk already, so the page read that follows has them.
      const page = state.page;
      if (!page) {
        return state;
      }
      const rows = mergeLiveRows(page.rows, message.rows ?? [], { hasMore: page.hasMore });
      if (rows.length === page.rows.length) {
        return state;
      }
      // `payloadFields` summarizes the whole batch, so a batch that only partly landed overcounts the
      // rows of a path until the next page replaces them. Every path is still listed, which is the safe side.
      return {
        ...state,
        page: { ...page, rows, payloadFields: mergePayloadFields(page.payloadFields, message.payloadFields ?? []) }
      };
    }
    case 'customLogsError':
      return { ...state, error: message.message };
  }
}

/** The messages that rebuild `state` in a fresh webview, in the order the webview expects them. */
export function replayCustomLogsView(state: CustomLogsViewState): CustomLogsToWebviewMessage[] {
  const messages: CustomLogsToWebviewMessage[] = [];
  if (state.locale !== undefined) {
    messages.push({ type: 'customLogsInit', locale: state.locale, surface: state.surface });
  }
  if (state.orgs) {
    messages.push({ type: 'customLogsOrgs', data: state.orgs.data, selected: state.orgs.selected });
  }
  if (state.sources) {
    messages.push({
      type: 'customLogsSources',
      data: state.sources.data,
      selected: state.sources.selected,
      issues: state.sources.issues
    });
  }
  messages.push(
    { type: 'customLogsFilter', value: state.filter },
    { type: 'customLogsPayloadColumns', value: state.payloadColumns }
  );
  if (state.page) {
    messages.push({ type: 'customLogsPage', mode: 'replace', ...state.page });
  }
  if (state.capture) {
    messages.push({ type: 'customLogsCapture', value: state.capture });
  }
  messages.push({ type: 'customLogsLoading', value: state.loading }, { type: 'customLogsError', message: state.error });
  return messages;
}
