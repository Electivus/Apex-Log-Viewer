import type { RuntimeDebugLevelRecord } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';

const levelSummary = 'Salesforce debug category level.';

export const debugLevelValueFlags = {
  'apex-code': Flags.string({ summary: levelSummary }),
  'apex-profiling': Flags.string({ summary: levelSummary }),
  callout: Flags.string({ summary: levelSummary }),
  'data-access': Flags.string({ summary: levelSummary }),
  database: Flags.string({ summary: levelSummary }),
  'developer-name': Flags.string({ summary: 'Debug level developer name.' }),
  language: Flags.string({ summary: 'Debug level language.' }),
  'master-label': Flags.string({ summary: 'Debug level label.' }),
  nba: Flags.string({ summary: levelSummary }),
  system: Flags.string({ summary: levelSummary }),
  validation: Flags.string({ summary: levelSummary }),
  visualforce: Flags.string({ summary: levelSummary }),
  wave: Flags.string({ summary: levelSummary }),
  workflow: Flags.string({ summary: levelSummary })
};

export type DebugLevelValueFlags = {
  'apex-code'?: string;
  'apex-profiling'?: string;
  callout?: string;
  'data-access'?: string;
  database?: string;
  'developer-name'?: string;
  language?: string;
  'master-label'?: string;
  nba?: string;
  system?: string;
  validation?: string;
  visualforce?: string;
  wave?: string;
  workflow?: string;
};

export function debugLevelRecord(flags: DebugLevelValueFlags, id?: string): RuntimeDebugLevelRecord {
  if (!flags['developer-name']) throw new Error('--developer-name is required.');
  return {
    id,
    developerName: flags['developer-name'],
    masterLabel: flags['master-label'] ?? flags['developer-name'],
    language: flags.language ?? 'None',
    workflow: flags.workflow ?? 'INFO',
    validation: flags.validation ?? 'INFO',
    callout: flags.callout ?? 'INFO',
    apexCode: flags['apex-code'] ?? 'DEBUG',
    apexProfiling: flags['apex-profiling'] ?? 'INFO',
    visualforce: flags.visualforce ?? 'INFO',
    system: flags.system ?? 'DEBUG',
    database: flags.database ?? 'INFO',
    wave: flags.wave ?? 'INFO',
    nba: flags.nba ?? 'INFO',
    dataAccess: flags['data-access'] ?? 'INFO'
  };
}
