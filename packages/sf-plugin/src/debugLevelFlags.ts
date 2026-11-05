import type { DebugLevelFields } from '@alv/core/contracts';
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

export function debugLevelFields(flags: DebugLevelValueFlags): Partial<DebugLevelFields> {
  return {
    developerName: flags['developer-name'],
    masterLabel: flags['master-label'],
    language: flags.language,
    workflow: flags.workflow,
    validation: flags.validation,
    callout: flags.callout,
    apexCode: flags['apex-code'],
    apexProfiling: flags['apex-profiling'],
    visualforce: flags.visualforce,
    system: flags.system,
    database: flags.database,
    wave: flags.wave,
    nba: flags.nba,
    dataAccess: flags['data-access']
  };
}
