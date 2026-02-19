import type { OrgItem } from './types';
import type { DebugFlagUser, UserTraceFlagStatus } from './debugFlagsTypes';

export type DebugFlagsFromWebviewMessage =
  | { type: 'debugFlagsReady' }
  | { type: 'debugFlagsSelectOrg'; target: string }
  | { type: 'debugFlagsSearchUsers'; query: string }
  | { type: 'debugFlagsSelectUser'; userId: string }
  | { type: 'debugFlagsApply'; userId: string; debugLevelName: string; ttlMinutes: number }
  | { type: 'debugFlagsRemove'; userId: string };

export type DebugFlagsToWebviewMessage =
  | { type: 'debugFlagsInit'; locale: string; defaultTtlMinutes: number }
  | { type: 'debugFlagsLoading'; scope: 'orgs' | 'users' | 'status' | 'action'; value: boolean }
  | { type: 'debugFlagsOrgs'; data: OrgItem[]; selected: string | undefined }
  | { type: 'debugFlagsUsers'; query: string; data: DebugFlagUser[] }
  | { type: 'debugFlagsDebugLevels'; data: string[]; active?: string }
  | { type: 'debugFlagsUserStatus'; userId: string; status?: UserTraceFlagStatus }
  | { type: 'debugFlagsNotice'; message: string; tone: 'success' | 'info' | 'warning' }
  | { type: 'debugFlagsError'; message: string };
