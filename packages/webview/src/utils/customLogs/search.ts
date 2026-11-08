import type {
  CustomLogEntry,
  CustomLogPayloadView,
  CustomLogRow,
  CustomLogScalar
} from '@alv/protocol/customLogsTypes';
import { formatLogTime } from './format';

declare const searchTermsBrand: unique symbol;
/** Lowercased words that must all occur in an item's text. Built only by `parseSearch`; empty means no search. */
export type SearchTerms = readonly string[] & { readonly [searchTermsBrand]: true };

/** Quotes, `and`, `=` and `>` are plain characters: the search has no syntax. */
export function parseSearch(query: string): SearchTerms {
  return query.toLowerCase().split(/\s+/).filter(Boolean) as readonly string[] as SearchTerms;
}

type SearchField = 'search' | 'skip';

type SearchedKey<Table> = Extract<{ [K in keyof Table]: Table[K] extends 'search' ? K : never }[keyof Table], string>;

/** A new row field fails `check-types` here until it is classified, and in `rowFieldText` once it is searched. */
const ROW_SEARCH_FIELDS = {
  id: 'search',
  time: 'search',
  title: 'search',
  user: 'search',
  level: 'search',
  counts: 'search',
  transactionId: 'search',
  requestId: 'search',
  extra: 'search',
  payload: 'search'
} as const satisfies Record<keyof CustomLogRow, SearchField>;

const ENTRY_SEARCH_FIELDS = {
  id: 'skip',
  sequence: 'skip',
  time: 'skip',
  level: 'search',
  rawLevel: 'search',
  message: 'search',
  previewClipped: 'skip',
  messageTruncated: 'skip',
  origin: 'search',
  user: 'search',
  exceptionType: 'search',
  recordId: 'search',
  system: 'skip',
  presentDetails: 'skip',
  extra: 'search',
  payload: 'search'
} as const satisfies Record<keyof CustomLogEntry, SearchField>;

function searchedKeys<Table extends Record<string, SearchField>>(table: Table): Array<SearchedKey<Table>> {
  return Object.keys(table).filter((key): key is SearchedKey<Table> => table[key] === 'search');
}

const ROW_SEARCHED = searchedKeys(ROW_SEARCH_FIELDS);
const ENTRY_SEARCHED = searchedKeys(ENTRY_SEARCH_FIELDS);

function scalarText(value: CustomLogScalar | undefined): string[] {
  return value === undefined ? [] : [String(value)];
}

/** A null record field shows as an empty cell, so it has no text to find. */
function extraText(extra: Readonly<Record<string, CustomLogScalar>>): string[] {
  return Object.entries(extra).flatMap(([key, value]) => (value === null ? [key] : [key, String(value)]));
}

/** A payload that did not parse has no text: long text never reaches the webview. */
function payloadText(payload: CustomLogPayloadView | undefined): string[] {
  if (payload?.state !== 'parsed') {
    return [];
  }
  return Object.entries(payload.values).flatMap(([path, value]) => [path, String(value)]);
}

function rowFieldText(row: CustomLogRow, key: SearchedKey<typeof ROW_SEARCH_FIELDS>): string[] {
  switch (key) {
    case 'id':
    case 'title':
    case 'user':
    case 'level':
    case 'transactionId':
    case 'requestId':
      return scalarText(row[key]);
    case 'time':
      return [row.time, formatLogTime(row.time)];
    case 'counts':
      return Object.values(row.counts ?? {}).flatMap(scalarText);
    case 'extra':
      return extraText(row.extra);
    case 'payload':
      return payloadText(row.payload);
    default: {
      const unclassified: never = key;
      return unclassified;
    }
  }
}

function entryFieldText(entry: CustomLogEntry, key: SearchedKey<typeof ENTRY_SEARCH_FIELDS>): string[] {
  switch (key) {
    case 'level':
    case 'rawLevel':
    case 'message':
    case 'origin':
    case 'user':
    case 'exceptionType':
    case 'recordId':
      return scalarText(entry[key]);
    case 'extra':
      return extraText(entry.extra);
    case 'payload':
      return payloadText(entry.payload);
    default: {
      const unclassified: never = key;
      return unclassified;
    }
  }
}

/**
 * Rows and entries never change once delivered, so each one's text is built once. The newline joins
 * segments a term can never span, since a term holds no whitespace.
 */
function memoizedText<T extends object>(
  cache: WeakMap<T, string>,
  segments: (item: T) => string[]
): (item: T) => string {
  return item => {
    const cached = cache.get(item);
    if (cached !== undefined) {
      return cached;
    }
    const text = segments(item).join('\n').toLowerCase();
    cache.set(item, text);
    return text;
  };
}

export const rowSearchText = memoizedText(new WeakMap<CustomLogRow, string>(), row =>
  ROW_SEARCHED.flatMap(key => rowFieldText(row, key))
);

export const entrySearchText = memoizedText(new WeakMap<CustomLogEntry, string>(), entry =>
  ENTRY_SEARCHED.flatMap(key => entryFieldText(entry, key))
);

export function matchesSearch(text: string, terms: SearchTerms): boolean {
  return terms.every(term => text.includes(term));
}

/** `items` itself when there is no search, so memoized consumers keep their identity. */
export function searchItems<T>(items: readonly T[], terms: SearchTerms, textOf: (item: T) => string): readonly T[] {
  return terms.length === 0 ? items : items.filter(item => matchesSearch(textOf(item), terms));
}
