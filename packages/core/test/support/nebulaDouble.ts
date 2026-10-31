import test from 'node:test';

import {
  salesforceError,
  startSalesforceDouble,
  type DoubleHandler,
  type DoubleRequest,
  type DoubleResponse,
  type SalesforceDouble
} from './salesforceDouble.ts';
import { describeBodies, type DescribeFixtureName } from './describeFixtures.ts';
import type { ObjectDescribe } from '../../src/customLogs/schema.ts';

export type NebulaOrg = SalesforceDouble & {
  soql: (kind: 'data' | 'tooling') => string[];
  metadataQueries: (entity: 'EntityDefinition' | 'FieldDefinition') => string[];
  describeRequests: () => string[];
};

export type NebulaOrgOptions = {
  /** The describe results the user under test gets. */
  describes: DescribeFixtureName;
  /** Objects EntityDefinition lists. */
  objects: readonly string[];
  /** FieldDefinition answers from this fixture: it lists fields whatever FLS hides (measured). */
  fieldDefinitions?: DescribeFixtureName;
  /** Answers data and ApexLog queries; return undefined to fall through to NOT_FOUND. */
  answer?: (soql: string, request: DoubleRequest) => DoubleResponse | undefined;
  /** Makes the Tooling metadata queries answer INSUFFICIENT_ACCESS. */
  refuseMetadata?: boolean;
  /** Objects beyond the fixture (a platform event, say): described and listed by FieldDefinition like the rest. */
  extraDescribes?: Readonly<Record<string, ObjectDescribe>>;
};

const IN_LIST = /\bIN \(([^)]*)\)/i;

function quotedNames(soql: string): string[] {
  return [...(IN_LIST.exec(soql)?.[1] ?? '').matchAll(/'([^']*)'/g)].map(match => match[1]!);
}

export const page = (records: unknown[], extra: Record<string, unknown> = {}): DoubleResponse => ({
  body: { totalSize: records.length, done: true, records, ...extra }
});

/** The REST answers of an org that serves EntityDefinition, FieldDefinition and describe from captured fixtures. */
export function nebulaHandler(options: NebulaOrgOptions): DoubleHandler {
  const describes = { ...describeBodies(options.describes), ...options.extraDescribes };
  const fieldSource = { ...describeBodies(options.fieldDefinitions ?? options.describes), ...options.extraDescribes };
  const listed = new Set(options.objects.map(name => name.toLowerCase()));
  return request => {
    const soql = request.query.get('q') ?? '';
    if (request.path === '/tooling/query' && /FROM (EntityDefinition|FieldDefinition)\b/.test(soql)) {
      if (options.refuseMetadata)
        return salesforceError('INSUFFICIENT_ACCESS', 'You do not have access to this API.', 403);
      if (/FROM EntityDefinition/.test(soql)) {
        const names = quotedNames(soql).filter(name => listed.has(name.toLowerCase()));
        return page(names.map(QualifiedApiName => ({ QualifiedApiName })));
      }
      const object = /EntityDefinition\.QualifiedApiName = '([^']*)'/.exec(soql)?.[1] ?? '';
      const fields = new Set((fieldSource[object]?.fields ?? []).map(field => field.name.toLowerCase()));
      return page(
        quotedNames(soql)
          .filter(name => fields.has(name.toLowerCase()))
          .map(QualifiedApiName => ({ QualifiedApiName }))
      );
    }
    const describeOf = /^\/sobjects\/([^/]+)\/describe$/.exec(request.path)?.[1];
    if (describeOf) {
      const body = describes[describeOf];
      return body ? { body } : salesforceError('NOT_FOUND', 'The requested resource does not exist', 404);
    }
    return (
      options.answer?.(soql, request) ??
      salesforceError('NOT_FOUND', `Unexpected ${request.method} ${request.path}`, 404)
    );
  };
}

/** A Salesforce org double that answers EntityDefinition, FieldDefinition and describe from captured fixtures. */
export async function startNebulaOrg(t: test.TestContext, options: NebulaOrgOptions): Promise<NebulaOrg> {
  const salesforce = await startSalesforceDouble(t, nebulaHandler(options));
  const queries = (kind: 'data' | 'tooling') =>
    salesforce.requests
      .filter(request => request.path === (kind === 'data' ? '/query' : '/tooling/query'))
      .map(request => request.query.get('q') ?? '');
  return {
    ...salesforce,
    get received() {
      return salesforce.received;
    },
    soql: queries,
    metadataQueries: entity => queries('tooling').filter(soql => soql.includes(`FROM ${entity}`)),
    describeRequests: () =>
      salesforce.requests
        .filter(request => /^\/sobjects\/[^/]+\/describe$/.test(request.path))
        .map(request => request.path)
  };
}
