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
  onDidChange(listener: (sourceId: string) => void): { dispose(): void };
}

const stores = new WeakMap<PayloadColumnsMemento, PayloadColumnsStore>();

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

/** UI-added JSON column paths in workspace state, keyed `entry:<source id>`. Internal state, not a setting. */
export function createPayloadColumnsStore(memento: PayloadColumnsMemento): PayloadColumnsStore {
  const existing = stores.get(memento);
  if (existing) {
    return existing;
  }
  const listeners = new Set<(sourceId: string) => void>();
  const pendingInvalidations = new Map<string, symbol>();
  const store: PayloadColumnsStore = {
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    read(sourceId, defaults) {
      const added = readStored(memento).get(storeKey(sourceId)) ?? [];
      return { defaults: [...defaults], added: added.filter(path => !defaults.includes(path)) };
    },
    async show(sourceId, path, shown) {
      const stored = readStored(memento);
      const key = storeKey(sourceId);
      const previous = stored.get(key) ?? [];
      const paths = parseCustomLogPayloadColumns(withPayloadColumn(previous, path, shown));
      if (!paths) {
        return;
      }
      const changed = paths.length !== previous.length || paths.some((path, index) => path !== previous[index]);
      const changedSources = new Set(changed ? [sourceId] : []);
      const previousKeys = [...stored.keys()];
      stored.delete(key);
      if (paths.length > 0) {
        stored.set(key, paths);
      }
      trimOldest(stored, MAX_STORED_LISTS);
      for (const previousKey of previousKeys) {
        if (previousKey !== key && previousKey.startsWith('entry:') && !stored.has(previousKey)) {
          changedSources.add(previousKey.slice('entry:'.length));
        }
      }
      for (const changedSource of changedSources) {
        pendingInvalidations.set(changedSource, Symbol());
      }
      const savingInvalidations = new Map(pendingInvalidations);
      // No await between the read and this update: the memento holds the new value at once, so a change the other
      // surface sends next reads it.
      await memento.update(CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY, Object.fromEntries(stored));
      // A completed save acknowledges only its revisions, not newer changes still awaiting persistence.
      for (const [changedSource, revision] of savingInvalidations) {
        if (pendingInvalidations.get(changedSource) === revision) {
          pendingInvalidations.delete(changedSource);
        }
      }
      const snapshot = [...listeners];
      for (const changedSource of savingInvalidations.keys()) {
        for (const listener of snapshot) {
          try {
            listener(changedSource);
          } catch (error) {
            console.error('Custom Logs payload columns listener failed', error);
          }
        }
      }
    }
  };
  stores.set(memento, store);
  return store;
}
