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
