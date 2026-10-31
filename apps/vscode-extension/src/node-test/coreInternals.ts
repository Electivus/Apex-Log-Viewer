import path from 'node:path';

const CORE_LIB = path.resolve(__dirname, '../../../../packages/core/lib');

function loadCoreModule<T>(relativePath: string): T {
  // The rules under test are internal to core, so the agreement tests read them from the built lib.
  return require(path.join(CORE_LIB, relativePath)) as T;
}

export const coreSince =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/since')>('customLogs/since.js');
export const coreLevels =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/levels')>('customLogs/levels.js');
export const coreContracts =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/contracts')>('customLogs/contracts.js');
export const coreEventIds =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/events/ids')>('customLogs/events/ids.js');
export const corePayload =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/payload')>('customLogs/payload.js');
export const coreConfig =
  loadCoreModule<typeof import('../../../../packages/core/lib/customLogs/config')>('customLogs/config.js');
export const coreSoql = loadCoreModule<typeof import('../../../../packages/core/lib/soql')>('soql.js');
