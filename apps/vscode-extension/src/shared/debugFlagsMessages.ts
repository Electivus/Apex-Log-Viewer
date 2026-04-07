import type { OrgItem } from './types';
import type { DebugFlagUser, DebugLevelPreset, DebugLevelRecord, TraceFlagTarget, TraceFlagTargetStatus } from './debugFlagsTypes';

export type DebugFlagsFromWebviewMessage =
  | { type: 'debugFlagsReady' }
  | { type: 'debugFlagsSelectOrg'; target: string }
  | { type: 'debugFlagsSearchUsers'; query: string }
  | { type: 'debugFlagsSelectTarget'; target: TraceFlagTarget }
  | { type: 'debugFlagsApply'; target: TraceFlagTarget; debugLevelName: string; ttlMinutes: number }
  | { type: 'debugFlagsManagerSave'; draft: DebugLevelRecord }
  | { type: 'debugFlagsManagerDelete'; debugLevelId: string }
  | { type: 'debugFlagsRemove'; target: TraceFlagTarget }
  | { type: 'debugFlagsClearLogs'; scope: 'all' | 'mine' };

export type DebugFlagsToWebviewMessage =
  | { type: 'debugFlagsInit'; locale: string; defaultTtlMinutes: number }
  | { type: 'debugFlagsLoading'; scope: 'orgs' | 'users' | 'status' | 'action'; value: boolean }
  | { type: 'debugFlagsOrgs'; data: OrgItem[]; selected: string | undefined }
  | { type: 'debugFlagsUsers'; query: string; data: DebugFlagUser[] }
  | { type: 'debugFlagsDebugLevels'; data: string[]; active?: string }
  | { type: 'debugFlagsManagerData'; records: DebugLevelRecord[]; presets: DebugLevelPreset[]; selectedId?: string }
  | { type: 'debugFlagsTargetStatus'; target: TraceFlagTarget; status?: TraceFlagTargetStatus }
  | { type: 'debugFlagsNotice'; message: string; tone: 'success' | 'info' | 'warning' }
  | { type: 'debugFlagsError'; message: string };

const MAX_ORG_IDENTIFIER_LENGTH = 320;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_DEBUG_LEVEL_NAME_LENGTH = 255;
const MAX_DEBUG_LEVEL_FIELD_LENGTH = 255;
const MAX_IDENTIFIER_LENGTH = 128;
const SALESFORCE_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function parseTrimmedString(value: unknown, maxLength: number): string | undefined {
  const parsed = parseString(value, maxLength);
  return parsed === undefined ? undefined : parsed.trim();
}

function parseIdentifier(value: unknown): string | undefined {
  const parsed = parseTrimmedString(value, MAX_IDENTIFIER_LENGTH);
  return parsed && SALESFORCE_ID_PATTERN.test(parsed) ? parsed : undefined;
}

function parseTraceFlagTarget(value: unknown): TraceFlagTarget | undefined {
  const target = asRecord(value);
  if (!target) {
    return undefined;
  }
  if (target.type === 'automatedProcess' || target.type === 'platformIntegration') {
    return { type: target.type };
  }
  if (target.type === 'user') {
    const userId = parseIdentifier(target.userId);
    return userId ? { type: 'user', userId } : undefined;
  }
  return undefined;
}

function parseIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : undefined;
}

function parseDebugLevelRecord(value: unknown): DebugLevelRecord | undefined {
  const draft = asRecord(value);
  if (!draft) {
    return undefined;
  }

  const requiredFields: Array<keyof DebugLevelRecord> = [
    'developerName',
    'masterLabel',
    'language',
    'workflow',
    'validation',
    'callout',
    'apexCode',
    'apexProfiling',
    'visualforce',
    'system',
    'database',
    'wave',
    'nba',
    'dataAccess'
  ];

  const record: Partial<DebugLevelRecord> = {};
  for (const field of requiredFields) {
    const parsed = parseString(draft[field], MAX_DEBUG_LEVEL_FIELD_LENGTH);
    if (parsed === undefined) {
      return undefined;
    }
    record[field] = parsed;
  }

  if (typeof draft.id !== 'undefined') {
    const id = parseIdentifier(draft.id);
    if (!id) {
      return undefined;
    }
    record.id = id;
  }

  return record as DebugLevelRecord;
}

export function parseDebugFlagsFromWebviewMessage(raw: unknown): DebugFlagsFromWebviewMessage | undefined {
  const message = asRecord(raw);
  if (!message) {
    return undefined;
  }

  switch (message.type) {
    case 'debugFlagsReady':
      return { type: 'debugFlagsReady' };
    case 'debugFlagsSelectOrg': {
      const target = parseTrimmedString(message.target, MAX_ORG_IDENTIFIER_LENGTH);
      return target !== undefined ? { type: 'debugFlagsSelectOrg', target } : undefined;
    }
    case 'debugFlagsSearchUsers': {
      const query = parseString(message.query, MAX_SEARCH_QUERY_LENGTH);
      return query !== undefined ? { type: 'debugFlagsSearchUsers', query } : undefined;
    }
    case 'debugFlagsSelectTarget': {
      const target = parseTraceFlagTarget(message.target);
      return target ? { type: 'debugFlagsSelectTarget', target } : undefined;
    }
    case 'debugFlagsApply': {
      const target = parseTraceFlagTarget(message.target);
      const debugLevelName = parseTrimmedString(message.debugLevelName, MAX_DEBUG_LEVEL_NAME_LENGTH);
      const ttlMinutes = parseIntegerInRange(message.ttlMinutes, 1, 1440);
      return target && debugLevelName && ttlMinutes
        ? { type: 'debugFlagsApply', target, debugLevelName, ttlMinutes }
        : undefined;
    }
    case 'debugFlagsManagerSave': {
      const draft = parseDebugLevelRecord(message.draft);
      return draft ? { type: 'debugFlagsManagerSave', draft } : undefined;
    }
    case 'debugFlagsManagerDelete': {
      const debugLevelId = parseIdentifier(message.debugLevelId);
      return debugLevelId ? { type: 'debugFlagsManagerDelete', debugLevelId } : undefined;
    }
    case 'debugFlagsRemove': {
      const target = parseTraceFlagTarget(message.target);
      return target ? { type: 'debugFlagsRemove', target } : undefined;
    }
    case 'debugFlagsClearLogs':
      if (message.scope === 'all' || message.scope === 'mine') {
        return { type: 'debugFlagsClearLogs', scope: message.scope };
      }
      return undefined;
    default:
      return undefined;
  }
}
