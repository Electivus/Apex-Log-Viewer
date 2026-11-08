import type { CustomLogEntry, CustomLogPayloadView, CustomLogRow } from '@alv/protocol/customLogsTypes';
import { formatLogTime } from '../utils/customLogs/format';
import { entrySearchText, matchesSearch, parseSearch, rowSearchText, searchItems } from '../utils/customLogs/search';

function parsed(values: Record<string, string | number | boolean | null>): CustomLogPayloadView {
  return { state: 'parsed', values, droppedPaths: 0, cutValues: [] };
}

function row(id: string, overrides: Partial<CustomLogRow> = {}): CustomLogRow {
  return { id, time: '2026-10-29T23:41:07.000Z', extra: {}, ...overrides };
}

function entry(id: string, overrides: Partial<CustomLogEntry> = {}): CustomLogEntry {
  return {
    id,
    sequence: 1,
    time: '2026-10-29T23:29:49.765Z',
    message: '',
    previewClipped: false,
    system: false,
    presentDetails: [],
    extra: {},
    ...overrides
  };
}

const rowsMatching = (rows: readonly CustomLogRow[], query: string) =>
  searchItems(rows, parseSearch(query), rowSearchText).map(item => item.id);

const entriesMatching = (entries: readonly CustomLogEntry[], query: string) =>
  searchItems(entries, parseSearch(query), entrySearchText).map(item => item.id);

describe('parsing a search', () => {
  it('splits on any whitespace into lowercase words', () => {
    expect([...parseSearch('  Order\tSYNC\n failed  ')]).toEqual(['order', 'sync', 'failed']);
  });

  it('reads a blank query as no search, and keeps the loaded items as they are', () => {
    const rows = [row('a'), row('b')];

    expect(parseSearch('   ')).toHaveLength(0);
    expect(searchItems(rows, parseSearch('   '), rowSearchText)).toBe(rows);
  });
});

describe('searching loaded rows', () => {
  const failed = row('a0B5g00000Zt1QwEAJ', {
    title: 'Order sync failed',
    level: 'ERROR',
    user: 'integration@acme.com',
    transactionId: 'TX-7781',
    requestId: 'REQ-42',
    counts: { entries: 9417, errors: 3 },
    extra: { Category__c: 'Orders', Retried__c: false, Region__c: null },
    payload: parsed({
      orderId: 'ORD-1042',
      'http.status': 502,
      'tags[0]': 'vip',
      retry: null,
      cached: false,
      attempt: 0
    })
  });
  const synced = row('a0B5g00000Zt1QuEAJ', {
    title: 'Order synced',
    level: 'INFO',
    user: 'dev@acme.com',
    extra: { Category__c: 'Orders' },
    payload: parsed({ orderId: 'ORD-1043', 'http.status': 200 })
  });
  const rows = [failed, synced];

  it('requires every word, each anywhere in the row, without regard to case', () => {
    expect(rowsMatching(rows, 'order')).toEqual([failed.id, synced.id]);
    expect(rowsMatching(rows, 'ORDER failed')).toEqual([failed.id]);
    expect(rowsMatching(rows, 'failed 200')).toEqual([]);
  });

  it('finds the id, title, level, user, transaction, request and counts', () => {
    for (const query of ['a0B5g00000Zt1QwEAJ', 'sync failed', 'error', 'integration@', 'tx-7781', 'req-42', '9417']) {
      expect(rowsMatching(rows, query)).toEqual([failed.id]);
    }
  });

  describe('in a time zone behind UTC', () => {
    const zone = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'America/Sao_Paulo';
    });
    afterAll(() => {
      process.env.TZ = zone;
    });

    it('finds the time as stored and as the Time column shows it', () => {
      const timed = row('timed', { time: '2026-10-29T23:41:07.000Z' });

      expect(formatLogTime(timed.time)).toBe('2026-10-29 20:41:07.000');
      expect(rowsMatching([timed], '2026-10-29t23:41')).toEqual([timed.id]);
      expect(rowsMatching([timed], '20:41:07.000')).toEqual([timed.id]);
    });
  });

  it('finds the values of the record columns, never their API names, and no text for an empty one', () => {
    expect(rowsMatching(rows, 'orders')).toEqual([failed.id, synced.id]);
    expect(rowsMatching(rows, 'orders false')).toEqual([failed.id]);
    for (const query of ['category__c', 'retried__c', 'region__c', 'category']) {
      expect(rowsMatching(rows, query)).toEqual([]);
    }
    expect(rowsMatching([row('blank', { extra: { Region__c: null } })], 'null')).toEqual([]);
  });

  it('does not match a word that only a record column API name holds, while a payload path still matches', () => {
    const header = row('a02DF0000089n6aYAA', {
      title: 'Log-000279',
      extra: { Status__c: 'New', SystemMode__c: 'ANONYMOUS', TransactionScenarioName__c: null }
    });
    const withPath = row('a02DF0000089n6bYAA', { title: 'Log-000280', payload: parsed({ status: 'ok' }) });

    for (const query of ['status', 'system', 'mode', 'transaction', 'scenario', 'name']) {
      expect(rowsMatching([header], query)).toEqual([]);
    }
    expect(rowsMatching([header], 'new anonymous')).toEqual([header.id]);
    expect(rowsMatching([header, withPath], 'status')).toEqual([withPath.id]);
  });

  it('finds the paths and values of a parsed payload, null, false and zero included', () => {
    expect(rowsMatching(rows, 'http.status 502')).toEqual([failed.id]);
    expect(rowsMatching(rows, 'tags[0] vip')).toEqual([failed.id]);
    for (const query of ['retry null', 'cached false', 'attempt 0']) {
      expect(rowsMatching(rows, query)).toEqual([failed.id]);
    }
  });

  it('reads quotes, and, = and >= as plain characters', () => {
    expect(rowsMatching(rows, 'http.status >= 500')).toEqual([]);
    expect(rowsMatching(rows, '"vip"')).toEqual([]);
    expect(rowsMatching(rows, 'orders and')).toEqual([]);
    expect(rowsMatching([row('x', { title: 'a=b and "quoted" >= 5' })], '"quoted" a=b >=')).toEqual(['x']);
  });

  it('never matches across two fields', () => {
    expect(rowsMatching(rows, 'failedintegration')).toEqual([]);
    expect(rowsMatching(rows, 'orderidord-1042')).toEqual([]);
  });

  it('has no payload text for a payload that did not parse', () => {
    for (const state of ['invalid', 'text', 'empty', 'hidden'] as const) {
      const unreadable = row('a0B5g00000Zt1QsEAJ', { title: 'Unreadable', payload: { state } });
      expect(rowsMatching([unreadable], state)).toEqual([]);
      expect(rowsMatching([unreadable], 'unreadable')).toEqual([unreadable.id]);
    }
  });

  it('searches a row delivered again with new content by that content', () => {
    expect(rowsMatching([synced], 'retried')).toEqual([]);

    const redelivered = { ...synced, title: 'Order synced after retried call' };

    expect(rowsMatching([redelivered], 'retried')).toEqual([synced.id]);
    expect(rowsMatching([synced], 'retried')).toEqual([]);
  });
});

describe('searching the entries of a transaction', () => {
  const boom = entry('a0C5g000001AbcdEAC', {
    sequence: 7,
    message: 'Division by zero in OrderMath',
    level: 'ERROR',
    rawLevel: 'ERROR',
    origin: 'OrderMath.divide',
    user: 'dev@acme.com',
    exceptionType: 'System.MathException',
    recordId: '0015g00000ABCDEAA4',
    extra: { Topic__c: 'billing' },
    payload: parsed({ 'invoice.total': 0, 'invoice.paid': false })
  });
  const start = entry('a0C5g000001AbceEAC', { sequence: 1, message: 'Starting OrderSync', level: 'INFO' });
  const odd = entry('a0C5g000001AbcfEAC', { sequence: 2, message: 'Custom level', rawLevel: 'NOTICE' });
  const entries = [start, odd, boom];

  it('finds the message, origin, user, exception, levels, record, record columns and payload', () => {
    for (const query of [
      'division zero',
      'ordermath.divide',
      'dev@acme.com',
      'mathexception',
      'error',
      '0015g00000ABCDEAA4',
      'billing',
      'invoice.total 0',
      'invoice.paid false'
    ]) {
      expect(entriesMatching(entries, query)).toEqual([boom.id]);
    }
    expect(entriesMatching(entries, 'notice')).toEqual([odd.id]);
  });

  it('does not match a word that only a record column API name holds', () => {
    const saved = entry('a01DF00000NvMjPYAV', {
      message: 'Saved order',
      extra: { Status__c: 'Processed', OriginType__c: 'Apex' }
    });

    for (const query of ['status', 'origin', 'type', 'topic__c']) {
      expect(entriesMatching([saved, boom], query)).toEqual([]);
    }
    expect(entriesMatching([saved, boom], 'processed apex')).toEqual([saved.id]);
  });

  it('requires every word, and keeps the loaded order', () => {
    expect(entriesMatching(entries, 'order')).toEqual([start.id, boom.id]);
    expect(entriesMatching(entries, 'order start')).toEqual([start.id]);
  });
});

describe('matching one text', () => {
  it('needs every term as a substring, and any text matches no terms', () => {
    const text = rowSearchText(row('x', { title: 'Order sync failed' }));

    expect(matchesSearch(text, parseSearch('sync ord'))).toBe(true);
    expect(matchesSearch(text, parseSearch('sync shipped'))).toBe(false);
    expect(matchesSearch(text, parseSearch(''))).toBe(true);
  });
});
