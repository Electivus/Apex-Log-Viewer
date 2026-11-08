import { trimOldest } from '../host/utils/trimOldest';
import {
  parseCustomLogPayloadColumns,
  withPayloadColumn,
  type CustomLogPayloadColumnsView
} from '../shared/customLogsTypes';

export const CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY = 'electivus.apexLogViewer.customLogs.payloadColumns';

/** The most distinct source lists kept; adding one more forgets the oldest. */
const MAX_STORED_LISTS = 100;

export interface PayloadColumnsMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PayloadColumnsStore {
  /** The mapping's entry defaults plus the columns this workspace added, minus any the defaults already show. */
  read(sourceId: string, defaults: readonly string[]): CustomLogPayloadColumnsView;
  /**
   * Shows or hides one added column of a source, applied to the list as stored when it runs. The list and the
   * transaction viewer each send their own changes, so neither drops a column the other added. The team's
   * defaults live in `sfdx-project.json`, never here.
   */
  show(sourceId: string, path: string, shown: boolean): Promise<void>;
}

/**
 * The list and the transaction viewer both show entries, so they share one list per source. `transaction:<id>`
 * lists an older build kept for header rows stay as they are until the cap forgets them.
 */
function storeKey(sourceId: string): string {
  return `entry:${sourceId}`;
}

function readStored(memento: PayloadColumnsMemento): Map<string, string[]> {
  const raw = memento.get<unknown>(CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY);
  const stored = new Map<string, string[]>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return stored;
  }
  for (const [key, value] of Object.entries(raw)) {
    const paths = parseCustomLogPayloadColumns(value);
    if (paths) {
      stored.set(key, paths);
    }
  }
  return stored;
}

/** UI-added JSON column paths in workspace state, keyed by source id. Internal state, not a setting. */
export function createPayloadColumnsStore(memento: PayloadColumnsMemento): PayloadColumnsStore {
  return {
    read(sourceId, defaults) {
      const added = readStored(memento).get(storeKey(sourceId)) ?? [];
      return { defaults: [...defaults], added: added.filter(path => !defaults.includes(path)) };
    },
    async show(sourceId, path, shown) {
      const stored = readStored(memento);
      const key = storeKey(sourceId);
      const paths = parseCustomLogPayloadColumns(withPayloadColumn(stored.get(key) ?? [], path, shown));
      if (!paths) {
        return;
      }
      stored.delete(key);
      if (paths.length > 0) {
        stored.set(key, paths);
      }
      trimOldest(stored, MAX_STORED_LISTS);
      // No await between the read and this update: the memento holds the new value at once, so a change the other
      // surface sends next reads it.
      await memento.update(CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY, Object.fromEntries(stored));
    }
  };
}
