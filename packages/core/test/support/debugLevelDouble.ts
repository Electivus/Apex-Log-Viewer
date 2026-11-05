import type test from 'node:test';

import {
  salesforceError,
  saveOrgAuth,
  startSalesforceDouble,
  type DoubleRequest,
  type DoubleResponse
} from './salesforceDouble.ts';

export const LEVEL_ID = '7dl000000000001AAA';

export const EXISTING_LEVEL: Record<string, string> = {
  Id: LEVEL_ID,
  DeveloperName: 'ALV_DEBUG',
  MasterLabel: 'ALV Debug Label',
  Language: 'de',
  Workflow: 'FINER',
  Validation: 'ERROR',
  Callout: 'WARN',
  ApexCode: 'FINE',
  ApexProfiling: 'FINE',
  Visualforce: 'FINE',
  System: 'FINER',
  Database: 'FINE',
  Wave: 'FINE',
  Nba: 'FINE',
  DataAccess: 'FINE'
};

const LEVELS = ['NONE', 'INTERNAL', 'FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

const RESTRICTED_PICKLISTS: Record<string, { label: string; values: string[] }> = {
  Language: { label: 'Master Language', values: ['en_US', 'de', 'pt_BR'] },
  Workflow: { label: 'Workflow', values: LEVELS },
  Validation: { label: 'Validation', values: LEVELS },
  Callout: { label: 'Callout', values: LEVELS },
  ApexCode: { label: 'Apex Code', values: LEVELS },
  ApexProfiling: { label: 'Apex Profiling', values: LEVELS },
  Visualforce: { label: 'Visualforce', values: LEVELS },
  System: { label: 'System', values: LEVELS },
  Database: { label: 'Database', values: LEVELS },
  Wave: { label: 'Wave', values: LEVELS },
  Nba: { label: 'Nba', values: LEVELS },
  DataAccess: { label: 'Access', values: LEVELS }
};

const describeBody = {
  fields: [
    { name: 'Id', label: 'Id', restrictedPicklist: false, picklistValues: [] },
    { name: 'DeveloperName', label: 'Name', restrictedPicklist: false, picklistValues: [] },
    { name: 'MasterLabel', label: 'Label', restrictedPicklist: false, picklistValues: [] },
    ...Object.entries(RESTRICTED_PICKLISTS).map(([name, { label, values }]) => ({
      name,
      label,
      restrictedPicklist: true,
      picklistValues: values.map(value => ({ value, active: true }))
    }))
  ]
};

/** As measured on a scratch org: DebugLevel picklists match in any case and store the canonical value. */
function canonicalValue(field: string, value: string): string | undefined {
  const picklist = RESTRICTED_PICKLISTS[field];
  return picklist ? picklist.values.find(allowed => allowed.toLowerCase() === value.toLowerCase()) : value;
}

function rejection(write: Record<string, string>): DoubleResponse | undefined {
  const bad = Object.entries(write).find(([field, value]) => canonicalValue(field, value) === undefined);
  return bad
    ? salesforceError(
        'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
        `${RESTRICTED_PICKLISTS[bad[0]]?.label}: bad value for restricted picklist field: ${bad[1]}`
      )
    : undefined;
}

const canonicalWrite = (write: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(write).map(([field, value]) => [field, canonicalValue(field, value) ?? value]));

const isDebugLevelWrite = (request: DoubleRequest) =>
  request.method !== 'GET' && request.path.startsWith('/tooling/sobjects/DebugLevel');

export async function debugLevelOrg(t: test.TestContext, username: string) {
  const levels = new Map<string, Record<string, string>>([[LEVEL_ID, { ...EXISTING_LEVEL }]]);
  const salesforce = await startSalesforceDouble(t, request => {
    if (request.method === 'GET' && request.path === '/tooling/sobjects/DebugLevel/describe') {
      return { body: describeBody };
    }
    if (request.method === 'GET' && request.path === '/tooling/query') {
      const id = (request.query.get('q') ?? '').match(/Id = '([^']+)'/)?.[1];
      const records = id && levels.has(id) ? [levels.get(id)] : [];
      return { body: { totalSize: records.length, done: true, records } };
    }
    if (request.method === 'POST' && request.path === '/tooling/sobjects/DebugLevel') {
      const write = JSON.parse(request.body);
      const rejected = rejection(write);
      if (rejected) return rejected;
      const id = '7dl000000000002AAA';
      levels.set(id, { ...canonicalWrite(write), Id: id });
      return { status: 201, body: { id, success: true, errors: [] } };
    }
    const patched = request.path.match(/^\/tooling\/sobjects\/DebugLevel\/([^/]+)$/)?.[1];
    if (request.method === 'PATCH' && patched) {
      const stored = levels.get(patched);
      if (!stored) return salesforceError('NOT_FOUND', 'The requested resource does not exist', 404);
      const write = JSON.parse(request.body);
      const rejected = rejection(write);
      if (rejected) return rejected;
      levels.set(patched, { ...stored, ...canonicalWrite(write) });
      return { status: 204, body: undefined };
    }
    return salesforceError('NOT_FOUND', `${request.method} ${request.path}`, 404);
  });
  await saveOrgAuth(username, salesforce.instanceUrl);
  return {
    salesforce,
    levels,
    writes: () =>
      salesforce.requests
        .filter(isDebugLevelWrite)
        .map(request => ({ method: request.method, path: request.path, body: JSON.parse(request.body) })),
    describes: () =>
      salesforce.requests.filter(request => request.path === '/tooling/sobjects/DebugLevel/describe').length
  };
}
