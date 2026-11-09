import type { CustomLogEntry, CustomLogLevel } from '@alv/protocol/customLogsTypes';
import {
  buildEntryColumns,
  countLevels,
  countPresentDetails,
  countSystemEntries,
  entrySortValue,
  filterEntries,
  revealEntry,
  type EntryFilters
} from '../utils/customLogs/entries';
import { parseSearch } from '../utils/customLogs/search';

function entry(id: string, overrides: Partial<CustomLogEntry> = {}): CustomLogEntry {
  return {
    id,
    sequence: 1,
    time: '2026-10-29T23:29:49.765Z',
    level: 'INFO',
    message: id,
    previewClipped: false,
    system: false,
    presentDetails: [],
    extra: {},
    ...overrides
  };
}

const everything: EntryFilters = { levels: new Set(), details: new Set(), showSystem: true, search: parseSearch('') };
const ids = (entries: readonly CustomLogEntry[]) => entries.map(item => item.id);

const entries = [
  entry('start', { sequence: 1, origin: 'OrderSync.run', presentDetails: ['StackTrace__c'] }),
  entry('system', { sequence: 2, level: 'FINEST', system: true }),
  entry('boom', {
    sequence: 3,
    level: 'ERROR',
    exceptionType: 'System.MathException',
    presentDetails: ['ExceptionStackTrace__c', 'StackTrace__c']
  }),
  entry('slow', { sequence: 4, level: 'WARN', origin: 'HttpClient.send', user: 'dev@acme.com' }),
  entry('odd', { sequence: 5, level: undefined, rawLevel: 'NOTICE' })
];

describe('filtering loaded entries', () => {
  it('hides the logger system messages unless asked', () => {
    expect(ids(filterEntries(entries, { ...everything, showSystem: false }))).toEqual(['start', 'boom', 'slow', 'odd']);
    expect(ids(filterEntries(entries, everything))).toHaveLength(5);
  });

  it('keeps any of the selected levels, and drops entries that have no canonical level when a level is selected', () => {
    const levels = new Set<CustomLogLevel>(['ERROR', 'WARN']);
    expect(ids(filterEntries(entries, { ...everything, levels }))).toEqual(['boom', 'slow']);
  });

  it('keeps entries that carry any of the selected long fields', () => {
    expect(ids(filterEntries(entries, { ...everything, details: new Set(['ExceptionStackTrace__c']) }))).toEqual([
      'boom'
    ]);
    expect(
      ids(filterEntries(entries, { ...everything, details: new Set(['StackTrace__c', 'ExceptionStackTrace__c']) }))
    ).toEqual(['start', 'boom']);
  });

  it('searches message, origin, user, exception type and raw level without regard to case', () => {
    const searched = (query: string) => ids(filterEntries(entries, { ...everything, search: parseSearch(query) }));

    expect(searched('HTTPCLIENT')).toEqual(['slow']);
    expect(searched('mathexception')).toEqual(['boom']);
    expect(searched('dev@acme')).toEqual(['slow']);
    expect(searched('notice')).toEqual(['odd']);
    expect(searched('   ')).toHaveLength(5);
  });

  it('searches the payload paths and values too, and only among the entries the other filters keep', () => {
    const withPayload = [
      entry('a', { payload: { state: 'parsed', values: { 'http.status': 502 }, droppedPaths: 0, cutValues: [] } }),
      entry('b', { payload: { state: 'parsed', values: { 'http.status': 200 }, droppedPaths: 0, cutValues: [] } }),
      entry('c', {
        level: 'ERROR',
        payload: { state: 'parsed', values: { 'http.status': 502 }, droppedPaths: 0, cutValues: [] }
      }),
      entry('d', { payload: { state: 'invalid' } })
    ];

    expect(ids(filterEntries(withPayload, { ...everything, search: parseSearch('http.status 502') }))).toEqual([
      'a',
      'c'
    ]);
    expect(
      ids(
        filterEntries(withPayload, {
          ...everything,
          levels: new Set<CustomLogLevel>(['ERROR']),
          search: parseSearch('502')
        })
      )
    ).toEqual(['c']);
  });
});

describe('summaries', () => {
  it('counts levels most severe first and skips the ones that are absent', () => {
    expect(countLevels(entries)).toEqual([
      { level: 'ERROR', count: 1 },
      { level: 'WARN', count: 1 },
      { level: 'INFO', count: 1 },
      { level: 'FINEST', count: 1 }
    ]);
  });

  it('counts the long fields entries flag as present, in first-seen order', () => {
    expect(countPresentDetails(entries)).toEqual([
      { key: 'StackTrace__c', count: 2 },
      { key: 'ExceptionStackTrace__c', count: 1 }
    ]);
  });

  it('counts the system entries', () => {
    expect(countSystemEntries(entries)).toBe(1);
  });
});

describe('entry columns', () => {
  const labels = { sequence: '#', time: 'Time', level: 'Level', origin: 'Origin', message: 'Message' };

  it('lists fixed columns, the source columns, then the JSON columns, and drops Origin when no entry has one', () => {
    const columns = buildEntryColumns({
      labels,
      extra: [{ key: 'OriginType__c', label: 'Origin Type' }],
      payload: [
        { path: 'orderId', origin: 'default' },
        { path: 'http.status', origin: 'added' }
      ],
      discovered: [{ path: 'orderId', types: ['string'], type: 'string', rows: 3, share: 50 }],
      hasOrigin: false
    });

    expect(columns.map(column => column.id)).toEqual([
      'std:sequence',
      'std:time',
      'std:level',
      'std:message',
      'extra:OriginType__c',
      'payload:orderId',
      'payload:http.status'
    ]);
    expect(columns.find(column => column.id === 'payload:orderId')).toMatchObject({
      locked: true,
      type: 'string',
      rows: 3
    });
    expect(columns.find(column => column.id === 'payload:http.status')).toMatchObject({ locked: false });
  });

  it('sorts levels by severity and payload columns by their first value', () => {
    const columns = buildEntryColumns({
      labels,
      extra: [],
      payload: [{ path: 'tags[]', origin: 'added' }],
      discovered: [],
      hasOrigin: true
    });
    const level = columns.find(column => column.id === 'std:level')!;
    const tags = columns.find(column => column.id === 'payload:tags[]')!;
    const tagged = entry('tagged', {
      level: 'ERROR',
      payload: { state: 'parsed', values: { 'tags[0]': 'vip', 'tags[1]': 'beta' }, droppedPaths: 0, cutValues: [] }
    });

    expect(entrySortValue(tagged, level)).toBeGreaterThan(entrySortValue(entry('info'), level) as number);
    expect(entrySortValue(entry('odd', { level: undefined }), level)).toBeUndefined();
    expect(entrySortValue(tagged, tags)).toBe('vip');
    expect(entrySortValue(entry('none'), tags)).toBeUndefined();
  });
});

describe('revealing an opened entry', () => {
  const narrowed: EntryFilters = {
    levels: new Set<CustomLogLevel>(['ERROR']),
    details: new Set(['ExceptionStackTrace__c']),
    showSystem: false,
    search: parseSearch('divide')
  };
  const shows = (filters: EntryFilters, target: CustomLogEntry) =>
    ids(filterEntries(entries, filters)).includes(target.id);

  it('turns on system messages for a system entry and leaves the other filters that already show it', () => {
    const system = entries[1]!;
    const filters: EntryFilters = { ...everything, showSystem: false, levels: new Set<CustomLogLevel>(['FINEST']) };

    const revealed = revealEntry(filters, system);

    expect(revealed).toEqual({ ...filters, showSystem: true });
    expect(revealed.levels).toBe(filters.levels);
    expect(shows(revealed, system)).toBe(true);
  });

  it('drops only the level, long-field and search filters that hide the entry', () => {
    const slow = entries[3]!;

    const revealed = revealEntry(narrowed, slow);

    expect(revealed.levels.size).toBe(0);
    expect(revealed.details.size).toBe(0);
    expect(revealed.search).toEqual([]);
    expect(revealed.showSystem).toBe(false);
    expect(shows(revealed, slow)).toBe(true);
  });

  it('keeps a search the entry matches and a long-field filter it carries', () => {
    const boom = entries[2]!;
    const filters: EntryFilters = {
      ...narrowed,
      levels: new Set<CustomLogLevel>(['WARN']),
      search: parseSearch('math')
    };

    const revealed = revealEntry(filters, boom);

    expect(revealed.search).toBe(filters.search);
    expect(revealed.details).toBe(filters.details);
    expect(revealed.levels.size).toBe(0);
  });

  it('drops a level filter for an entry without a canonical level', () => {
    expect(revealEntry({ ...everything, levels: new Set<CustomLogLevel>(['ERROR']) }, entries[4]!).levels.size).toBe(0);
  });

  it('returns the same filters when the entry already shows, so revealing twice changes nothing', () => {
    for (const target of entries) {
      const once = revealEntry(narrowed, target);
      expect(revealEntry(once, target)).toBe(once);
    }
    expect(revealEntry(everything, entries[0]!)).toBe(everything);
  });
});
