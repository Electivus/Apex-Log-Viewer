import {
  customLogTextFormat,
  type CustomLogEntryResult,
  type CustomLogLongValue,
  type CustomLogTextFormat
} from '@alv/core/contracts';
import type { CustomLogLongFieldView } from '../shared/customLogsTypes';

/** A long value the host keeps to open as a document. The webview only ever gets the matching `CustomLogLongFieldView`. */
export interface HeldLongText {
  label: string;
  text: string;
  format: CustomLogTextFormat;
}

export interface LongFieldLabels {
  message: string;
  payload: string;
}

export interface BuiltLongFields {
  /** In display order: `message`, each mapped detail, then `payload`. Fields the source does not map are left out. */
  views: CustomLogLongFieldView[];
  /** The openable text, by field key. Only fields in the `value` state are here. */
  held: Map<string, HeldLongText>;
}

export function longFieldView(key: string, label: string, value: CustomLogLongValue): CustomLogLongFieldView {
  if (value.state !== 'value') {
    return { key, label, state: value.state };
  }
  return {
    key,
    label,
    state: 'value',
    format: value.format,
    ...(value.truncated !== undefined ? { truncated: value.truncated } : {})
  };
}

function add(fields: BuiltLongFields, key: string, label: string, value: CustomLogLongValue): void {
  if (value.state === 'unmapped') {
    return;
  }
  fields.views.push(longFieldView(key, label, value));
  if (value.state === 'value') {
    fields.held.set(key, { label, text: value.value, format: value.format });
  }
}

/**
 * The long fields of one entry, from core's `entry` result. The full message always has a field,
 * so a row core clipped for the list can still be read whole.
 */
export function buildEntryFields(result: CustomLogEntryResult, labels: LongFieldLabels): BuiltLongFields {
  const fields: BuiltLongFields = { views: [], held: new Map() };
  const { message, messageTruncated } = result.entry;
  add(
    fields,
    'message',
    labels.message,
    message.length === 0
      ? { state: 'empty' }
      : {
          state: 'value',
          value: message,
          format: customLogTextFormat(message),
          ...(messageTruncated !== undefined ? { truncated: messageTruncated } : {})
        }
  );
  for (const detail of result.details) {
    add(fields, detail.key, detail.label, detail);
  }
  add(fields, 'payload', labels.payload, result.rawPayload);
  return fields;
}

/** The header payload of a transaction, or nothing when the source maps none. */
export function buildHeaderPayloadField(
  value: CustomLogLongValue | undefined,
  label: string
): { view: CustomLogLongFieldView; held?: HeldLongText } | undefined {
  if (!value || value.state === 'unmapped') {
    return undefined;
  }
  return {
    view: longFieldView('payload', label, value),
    ...(value.state === 'value' ? { held: { label, text: value.value, format: value.format } } : {})
  };
}
