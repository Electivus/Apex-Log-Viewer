/**
 * The transaction detail editor panel (one per org + source + log id), direct-post like
 * `LogViewerPanel`, with `retainContextWhenHidden`. Its state is fully determined by its key,
 * so a ready message simply triggers a fetch; no session replay is needed.
 *
 * Entries arrive inline as DTOs (there is no file to `fetch`), paged by the host. Level, text and
 * JSON-column filters run in the webview over loaded entries; system messages are hidden by
 * default and revealed with a toggle. The panel has no pane for long text: a selected entry shows
 * the list of its long fields, and opening one asks the host to show it as a read-only text
 * document (`json` or `plaintext`), where search, folding and formatting come from the editor.
 */

import {
  parseCustomLogPayloadColumns,
  parseCustomLogRowId,
  type CustomLogApexLogLink,
  type CustomLogColumn,
  type CustomLogEntry,
  type CustomLogLongFieldView,
  type CustomLogPayloadColumnsView,
  type CustomLogPayloadField,
  type CustomLogRow,
  type CustomLogSourceRef
} from './customLogsTypes.js';

/**
 * A field the panel delivered: an entry's field from `customLogViewerEntryFields`, or the header payload announced
 * in `customLogViewerInit`. The webview names it by key; its text stays in the host.
 */
export type CustomLogViewerFieldTarget = { kind: 'entry'; entryId: string; key: string } | { kind: 'logPayload' };

export type CustomLogViewerFromWebviewMessage =
  | { type: 'customLogViewerReady' }
  | { type: 'customLogViewerRefresh' }
  | { type: 'customLogViewerLoadMoreEntries' }
  /** Accepted only for an entry id the panel has delivered. The host answers with `customLogViewerEntryFields`. */
  | { type: 'customLogViewerOpenEntry'; entryId: string }
  /** The host opens the whole value it holds for the field. */
  | { type: 'customLogViewerOpenField'; target: CustomLogViewerFieldTarget }
  /** The host copies the whole value it holds for the field, which the webview may only show as a preview. */
  | { type: 'customLogViewerCopyField'; target: CustomLogViewerFieldTarget }
  /** No id: the panel opens the link it holds, so the webview cannot ask for an arbitrary ApexLog. */
  | { type: 'customLogViewerOpenApexLog' }
  | { type: 'customLogViewerSetPayloadColumns'; added: string[] }
  /** For short values the webview shows whole, such as the transaction and request ids. */
  | { type: 'customLogViewerCopyText'; text: string };

export type CustomLogViewerToWebviewMessage =
  | {
      type: 'customLogViewerInit';
      locale: string;
      source: CustomLogSourceRef;
      log: CustomLogRow;
      /** The header payload's state, when the source maps one; its text stays in the host. */
      logPayload?: CustomLogLongFieldView;
      entryColumns: CustomLogColumn[];
      payloadColumns: CustomLogPayloadColumnsView;
      apexLog: CustomLogApexLogLink;
    }
  | {
      type: 'customLogViewerEntries';
      mode: 'replace' | 'append';
      entries: CustomLogEntry[];
      payloadFields: CustomLogPayloadField[];
      hasMore: boolean;
    }
  /** `message` first, then each detail in definition order, then `payload`. */
  | { type: 'customLogViewerEntryFields'; entryId: string; fields: CustomLogLongFieldView[] }
  | { type: 'customLogViewerPayloadColumns'; value: CustomLogPayloadColumnsView }
  | { type: 'customLogViewerLoading'; scope: 'log' | 'entries' | 'entry'; value: boolean }
  | { type: 'customLogViewerError'; scope: 'log' | 'entries' | 'entry' | 'field' | 'apexLog'; message: string };

const MAX_CLIPBOARD_COPY_TEXT_LENGTH = 1_000_000;
const FIELD_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function parseFieldTarget(value: unknown): CustomLogViewerFieldTarget | undefined {
  const target = asRecord(value);
  if (!target) {
    return undefined;
  }
  if (target.kind === 'logPayload') {
    return { kind: 'logPayload' };
  }
  if (target.kind === 'entry') {
    const entryId = parseCustomLogRowId(target.entryId);
    const key = typeof target.key === 'string' && FIELD_KEY_PATTERN.test(target.key) ? target.key : undefined;
    return entryId && key ? { kind: 'entry', entryId, key } : undefined;
  }
  return undefined;
}

export function parseCustomLogViewerFromWebviewMessage(raw: unknown): CustomLogViewerFromWebviewMessage | undefined {
  const message = asRecord(raw);
  if (!message) {
    return undefined;
  }

  switch (message.type) {
    case 'customLogViewerReady':
    case 'customLogViewerRefresh':
    case 'customLogViewerLoadMoreEntries':
    case 'customLogViewerOpenApexLog':
      return { type: message.type };
    case 'customLogViewerOpenEntry': {
      const entryId = parseCustomLogRowId(message.entryId);
      return entryId ? { type: 'customLogViewerOpenEntry', entryId } : undefined;
    }
    case 'customLogViewerOpenField':
    case 'customLogViewerCopyField': {
      const target = parseFieldTarget(message.target);
      return target ? { type: message.type, target } : undefined;
    }
    case 'customLogViewerSetPayloadColumns': {
      const added = parseCustomLogPayloadColumns(message.added);
      return added ? { type: 'customLogViewerSetPayloadColumns', added } : undefined;
    }
    case 'customLogViewerCopyText': {
      const text = parseString(message.text, MAX_CLIPBOARD_COPY_TEXT_LENGTH);
      return text && text.length > 0 ? { type: 'customLogViewerCopyText', text } : undefined;
    }
    default:
      return undefined;
  }
}
