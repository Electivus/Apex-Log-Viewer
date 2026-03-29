import type { DebugLevelPreset, DebugLevelRecord } from './debugFlagsTypes';

export const DEBUG_LEVEL_LOG_LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'] as const;

export type DebugLevelFieldKey =
  | 'workflow'
  | 'validation'
  | 'callout'
  | 'apexCode'
  | 'apexProfiling'
  | 'visualforce'
  | 'system'
  | 'database'
  | 'wave'
  | 'nba'
  | 'dataAccess';

export const DEBUG_LEVEL_FIELDS: ReadonlyArray<{ key: DebugLevelFieldKey; label: string }> = [
  { key: 'workflow', label: 'Workflow' },
  { key: 'validation', label: 'Validation' },
  { key: 'callout', label: 'Callout' },
  { key: 'apexCode', label: 'Apex Code' },
  { key: 'apexProfiling', label: 'Apex Profiling' },
  { key: 'visualforce', label: 'Visualforce' },
  { key: 'system', label: 'System' },
  { key: 'database', label: 'Database' },
  { key: 'wave', label: 'Wave' },
  { key: 'nba', label: 'Nba' },
  { key: 'dataAccess', label: 'Data Access' }
];

export function createEmptyDebugLevelRecord(): DebugLevelRecord {
  return {
    developerName: '',
    masterLabel: '',
    language: 'en_US',
    workflow: 'INFO',
    validation: 'INFO',
    callout: 'INFO',
    apexCode: 'INFO',
    apexProfiling: 'INFO',
    visualforce: 'INFO',
    system: 'INFO',
    database: 'INFO',
    wave: 'INFO',
    nba: 'INFO',
    dataAccess: 'INFO'
  };
}

export const DEBUG_LEVEL_PRESETS: DebugLevelPreset[] = [
  {
    id: 'developer-focus',
    label: 'Developer Focus',
    description: 'Balanced defaults for Apex execution and general debugging.',
    record: {
      ...createEmptyDebugLevelRecord(),
      developerName: 'ALV_DEVELOPER_FOCUS',
      masterLabel: 'ALV Developer Focus',
      apexCode: 'DEBUG',
      apexProfiling: 'INFO',
      system: 'DEBUG',
      database: 'WARN'
    }
  },
  {
    id: 'integration-troubleshooting',
    label: 'Integration Troubleshooting',
    description: 'Higher visibility for callouts, system output, and related Apex execution.',
    record: {
      ...createEmptyDebugLevelRecord(),
      developerName: 'ALV_INTEGRATION',
      masterLabel: 'ALV Integration',
      callout: 'DEBUG',
      apexCode: 'DEBUG',
      system: 'DEBUG',
      validation: 'WARN',
      dataAccess: 'WARN'
    }
  },
  {
    id: 'validation-and-flow',
    label: 'Validation and Flow',
    description: 'Focused on workflow, validation rules, and related automation activity.',
    record: {
      ...createEmptyDebugLevelRecord(),
      developerName: 'ALV_AUTOMATION',
      masterLabel: 'ALV Automation',
      workflow: 'DEBUG',
      validation: 'DEBUG',
      apexCode: 'INFO',
      system: 'WARN'
    }
  },
  {
    id: 'performance-and-database',
    label: 'Performance and Database',
    description: 'Useful when inspecting SOQL, profiling, and database-heavy transactions.',
    record: {
      ...createEmptyDebugLevelRecord(),
      developerName: 'ALV_PERFORMANCE',
      masterLabel: 'ALV Performance',
      database: 'DEBUG',
      apexProfiling: 'DEBUG',
      apexCode: 'INFO',
      system: 'WARN'
    }
  }
];
