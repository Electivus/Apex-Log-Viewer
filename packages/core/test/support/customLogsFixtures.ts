/** Mappings shared by the parser and schema tests. Plain JSON, as a user would write it. */

export type Json = Record<string, unknown>;

export const appLogSource: Json = {
  id: 'app-log',
  label: 'App Log',
  entry: {
    object: 'App_Log__c',
    fields: {
      time: 'CreatedDate',
      message: 'Message__c',
      level: 'Severity__c',
      origin: 'Source__c',
      user: 'CreatedBy.Username',
      transactionId: 'Transaction_Id__c',
      requestId: 'Request_Id__c'
    },
    columns: ['Category__c'],
    details: ['Stack_Trace__c', { field: 'Http_Body__c', truncated: 'Http_Body_Truncated__c' }],
    payload: { field: 'Payload__c', columns: ['orderId', 'http.status'] }
  },
  levels: { Critical: 'ERROR', Notice: 'INFO' }
};

export function projectWith(source: Json): Json {
  return { plugins: { electivus: { customLogs: { sources: [source] } } } };
}

export const usageProject: Json = {
  packageDirectories: [{ path: 'force-app', default: true }],
  sourceApiVersion: '65.0',
  ...projectWith(appLogSource)
};

export function entrySource(props: Json): Json {
  return { ...appLogSource, entry: { ...(appLogSource.entry as Json), ...props } };
}

const header: Json = { object: 'Acme_Log__c', fields: { startTime: 'CreatedDate' } };

export function headerSource(props: Json): Json {
  return {
    id: 'acme',
    transaction: { ...header, ...props },
    entry: {
      object: 'Acme_Log_Entry__c',
      parent: 'Acme_Log__c',
      fields: { time: 'CreatedDate', message: 'Message__c' }
    }
  };
}

export const headerFields = header.fields as Json;
