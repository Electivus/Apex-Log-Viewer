import { trimOldest } from '../host/utils/trimOldest';
import { parseCustomLogPayloadColumns, type CustomLogPayloadColumnsView } from '../shared/customLogsTypes';

/** What a list row or a viewer entry is, which decides whose payload columns these are. */
export type CustomLogPayloadLevel = 'transaction' | 'entry';

export const CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY = 'electivus.apexLogViewer.customLogs.payloadColumns';

/** The most distinct (level, source) lists kept; adding one more forgets the oldest. */
const MAX_STORED_LISTS = 100;

export interface PayloadColumnsMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface PayloadColumnsStore {
  /** The mapping's defaults plus the columns this workspace added, minus any the defaults already show. */
  read(sourceId: string, level: CustomLogPayloadLevel, defaults: readonly string[]): CustomLogPayloadColumnsView;
  /** Replaces the added columns of one source and level. The team's defaults live in `sfdx-project.json`, never here. */
  write(sourceId: string, level: CustomLogPayloadLevel, added: readonly string[]): Promise<void>;
}

function storeKey(sourceId: string, level: CustomLogPayloadLevel): string {
  return `${level}:${sourceId}`;
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

/** UI-added JSON column paths in workspace state, keyed by source id and level. Internal state, not a setting. */
export function createPayloadColumnsStore(memento: PayloadColumnsMemento): PayloadColumnsStore {
  return {
    read(sourceId, level, defaults) {
      const added = readStored(memento).get(storeKey(sourceId, level)) ?? [];
      return { defaults: [...defaults], added: added.filter(path => !defaults.includes(path)) };
    },
    async write(sourceId, level, added) {
      const paths = parseCustomLogPayloadColumns([...added]);
      if (!paths) {
        return;
      }
      const stored = readStored(memento);
      const key = storeKey(sourceId, level);
      stored.delete(key);
      if (paths.length > 0) {
        stored.set(key, paths);
      }
      trimOldest(stored, MAX_STORED_LISTS);
      await memento.update(CUSTOM_LOGS_PAYLOAD_COLUMNS_STATE_KEY, Object.fromEntries(stored));
    }
  };
}
