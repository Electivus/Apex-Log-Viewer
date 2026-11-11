#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const EXTENSION_ID = 'electivus.apex-log-viewer';
const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const PAGE_SIZE = 50;

const FILTER_TARGET = 8;
const FILTER_SEARCH_TEXT = 10;
const FILTER_EXCLUDE_WITH_FLAGS = 12;
const FLAG_UNPUBLISHED = '4096';
const SORT_BY_RELEVANCE = 0;
const SORT_ORDER_DEFAULT = 0;
const RESPONSE_FLAGS = 914;

const DEFAULT_TERMS = [
  'apex log',
  'apex replay',
  'salesforce debug log',
  'salesforce log',
  'debug log',
  'debug logs',
  'trace flag',
  'sfdx',
  'sf cli',
  'nebula logger',
  'log analyzer'
];

export function buildQuery(term) {
  return {
    filters: [
      {
        criteria: [
          { filterType: FILTER_TARGET, value: 'Microsoft.VisualStudio.Code' },
          { filterType: FILTER_SEARCH_TEXT, value: term },
          { filterType: FILTER_EXCLUDE_WITH_FLAGS, value: FLAG_UNPUBLISHED }
        ],
        pageNumber: 1,
        pageSize: PAGE_SIZE,
        sortBy: SORT_BY_RELEVANCE,
        sortOrder: SORT_ORDER_DEFAULT
      }
    ],
    flags: RESPONSE_FLAGS
  };
}

export async function searchRank(term, fetchImpl = fetch) {
  const response = await fetchImpl(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
    body: JSON.stringify(buildQuery(term))
  });
  if (!response.ok) {
    throw new Error(`Marketplace answered HTTP ${response.status} for "${term}"`);
  }
  const json = await response.json();
  const extensions = json?.results?.[0]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error(`Marketplace response for "${term}" has no results[0].extensions array`);
  }
  const ids = extensions.map(extension => `${extension.publisher.publisherName}.${extension.extensionName}`);
  const index = ids.map(id => id.toLowerCase()).indexOf(EXTENSION_ID);
  return { term, rank: index === -1 ? null : index + 1, total: ids.length, top: ids.slice(0, 3) };
}

export function formatResult({ term, rank, total, top }) {
  return `${term}: ${rank ?? `>${PAGE_SIZE}`} of ${total}; top3 ${top.join(', ')}`;
}

async function main(terms) {
  for (const term of terms.length > 0 ? terms : DEFAULT_TERMS) {
    console.log(formatResult(await searchRank(term)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
