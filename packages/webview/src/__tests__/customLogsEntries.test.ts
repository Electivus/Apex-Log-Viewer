import type { CustomLogEntry, CustomLogLevel } from '@alv/protocol/customLogsTypes';
import { parseFilterExpression } from '../utils/customLogs/filterGrammar';
import {
  buildEntryColumns,
  countLevels,
  countPresentDetails,
  countSystemEntries,
  entrySortValue,
  filterEntries,
  type EntryFilters
} from '../utils/customLogs/entries';

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

const everything: EntryFilters = { levels: new Set(), details: new Set(), text: '', showSystem: true, payload: [] };
const ids = (entries: CustomLogEntry[]) => entries.map(item => item.id);

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
    expect(ids(filterEntries(entries, { ...everything, text: 'HTTPCLIENT' }))).toEqual(['slow']);
    expect(ids(filterEntries(entries, { ...everything, text: 'mathexception' }))).toEqual(['boom']);
    expect(ids(filterEntries(entries, { ...everything, text: 'dev@acme' }))).toEqual(['slow']);
    expect(ids(filterEntries(entries, { ...everything, text: 'notice' }))).toEqual(['odd']);
    expect(ids(filterEntries(entries, { ...everything, text: '   ' }))).toHaveLength(5);
  });

  it('applies the payload filters after the others', () => {
    const withPayload = [
      entry('a', { payload: { state: 'parsed', values: { 'http.status': 502 }, droppedPaths: 0, cutValues: [] } }),
      entry('b', { payload: { state: 'parsed', values: { 'http.status': 200 }, droppedPaths: 0, cutValues: [] } }),
      entry('c', { payload: { state: 'invalid' } })
    ];
    const parsed = parseFilterExpression('http.status >= 500');
    if (!parsed.ok) {
      throw new Error('filter did not parse');
    }
    expect(ids(filterEntries(withPayload, { ...everything, payload: parsed.conditions }))).toEqual(['a']);
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
