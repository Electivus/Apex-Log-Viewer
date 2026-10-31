import assert from 'node:assert/strict';

import { cometdCursor, parseEventUuid, type EventUuid } from '../../src/customLogs/events/ids.ts';
import { openEventStore } from '../../src/customLogs/events/store.ts';
import type { BusEvent } from '../../src/customLogs/events/transport.ts';
import type { ObjectDescribe } from '../../src/customLogs/schema.ts';
import { ORG_ID } from './salesforceDouble.ts';

export const uuidOf = (n: number): EventUuid => {
  const uuid = parseEventUuid(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);
  assert.ok(uuid);
  return uuid;
};

/** An event as the transport delivers it: numbered `n`, created at `createdMs`, carrying `payload` beside its `CreatedDate`. */
export function busEvent(n: number, createdMs: number, payload: Record<string, unknown> = {}): BusEvent {
  const createdDate = new Date(createdMs).toISOString();
  return {
    uuid: uuidOf(n),
    cursor: cometdCursor(1_000 + n),
    createdDate,
    payload: { CreatedDate: createdDate, ...payload },
    bytes: 100
  };
}

/**
 * Writes what a finished capture leaves behind through the store's own writer: the describe, the
 * events and, when there are events, the checkpoint. With none, the store holds only a describe, as
 * a first-use `needsInitial` run leaves it.
 */
export async function seedEventStore(input: {
  root: string;
  username: string;
  describe: ObjectDescribe;
  events: readonly BusEvent[];
  orgId?: string;
}): Promise<void> {
  const { root, username, describe, events } = input;
  const store = openEventStore({ root, username, object: describe.name });
  const opened = await store.openWriter('cli');
  assert.ok('writer' in opened, 'the capture lease was free');
  const { writer } = opened;
  try {
    await writer.writeDescribe(describe);
    const last = events.at(-1);
    if (!last) return;
    await writer.append(events);
    await writer.advance({
      orgId: input.orgId ?? ORG_ID,
      transport: 'cometd',
      channel: `/event/${describe.name}`,
      cursor: last.cursor,
      lastEvent: { createdDate: last.createdDate, uuid: last.uuid }
    });
  } finally {
    await writer.release();
  }
}
