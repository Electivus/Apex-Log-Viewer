import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResult, searchRank } from './marketplace-search-rank.mjs';

function listing(publisherName, extensionName) {
  return { publisher: { publisherName }, extensionName };
}

function fakeFetch({ extensions, ok = true, status = 200, results } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status, json: async () => results ?? { results: [{ extensions }] } };
  };
  return { impl, calls };
}

test('searchRank matches the publisher case-insensitively and counts from 1', async () => {
  const { impl } = fakeFetch({
    extensions: [
      listing('financialforce', 'lana'),
      listing('salesforce', 'salesforcedx-vscode-apex-log'),
      listing('Electivus', 'apex-log-viewer')
    ]
  });

  const result = await searchRank('apex log', impl);

  assert.deepEqual(result, {
    term: 'apex log',
    rank: 3,
    total: 3,
    top: ['financialforce.lana', 'salesforce.salesforcedx-vscode-apex-log', 'Electivus.apex-log-viewer']
  });
});

test('searchRank ignores a listing with the same name from another publisher', async () => {
  const { impl } = fakeFetch({ extensions: [listing('someone-else', 'apex-log-viewer')] });

  const { rank } = await searchRank('apex log', impl);

  assert.equal(rank, null);
});

test('searchRank reports no rank when the extension is not on the first page', async () => {
  const { impl } = fakeFetch({ extensions: [listing('a', 'b'), listing('c', 'd')] });

  const result = await searchRank('trace flag', impl);

  assert.equal(result.rank, null);
  assert.equal(formatResult(result), 'trace flag: >50 of 2; top3 a.b, c.d');
});

test('formatResult prints the rank, the page size and the top three', () => {
  assert.equal(
    formatResult({ term: 'apex log', rank: 9, total: 50, top: ['a.a', 'b.b', 'c.c'] }),
    'apex log: 9 of 50; top3 a.a, b.b, c.c'
  );
});

test('searchRank queries VS Code extensions by the term in relevance order', async () => {
  const { impl, calls } = fakeFetch({ extensions: [] });

  await searchRank('sf cli', impl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery');
  const [filter] = calls[0].body.filters;
  assert.deepEqual(filter.criteria.slice(0, 2), [
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
    { filterType: 10, value: 'sf cli' }
  ]);
  assert.equal(filter.sortBy, 0);
  assert.equal(filter.pageNumber, 1);
  assert.equal(filter.pageSize, 50);
});

test('searchRank fails on an HTTP error instead of reporting a rank', async () => {
  const { impl } = fakeFetch({ ok: false, status: 503 });

  await assert.rejects(searchRank('apex log', impl), /HTTP 503 for "apex log"/);
});

test('searchRank fails on a response without an extensions array', async () => {
  const { impl } = fakeFetch({ results: { results: [] } });

  await assert.rejects(searchRank('apex log', impl), /no results\[0\]\.extensions array/);
});
