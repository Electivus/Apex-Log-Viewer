import { AuthInfo, Connection, Org, StreamingClient } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import type { AnyJson, JsonMap } from '@salesforce/ts-types';
import type { OrgAuth } from './types';

export type { StreamingClient };

export type StreamProcessor = (message: JsonMap) => { completed: boolean; payload?: AnyJson };

export async function createConnectionFromAuth(auth: OrgAuth): Promise<Connection> {
  const authInfo = await AuthInfo.create({
    accessTokenOptions: { accessToken: auth.accessToken, instanceUrl: auth.instanceUrl }
  });
  const connection = await Connection.create({ authInfo });
  return connection;
}

export async function createOrgFromConnection(connection: Connection): Promise<Org> {
  const org = await Org.create({ connection });
  return org;
}

export async function createLoggingStreamingClient(
  org: Org,
  streamProcessor: StreamProcessor
): Promise<StreamingClient> {
  const options = new StreamingClient.DefaultOptions(org, '/systemTopic/Logging', streamProcessor);
  // Align subscribe timeout to our tail hard-stop (30 minutes) like apex-node does
  try {
    options.setSubscribeTimeout(Duration.minutes(30));
  } catch {}
  // For system topics, DefaultOptions will force API 36.0 automatically.
  return StreamingClient.create(options);
}
