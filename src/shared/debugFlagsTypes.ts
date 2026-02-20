export interface DebugFlagUser {
  id: string;
  name: string;
  username: string;
  active: boolean;
}

export interface UserTraceFlagStatus {
  traceFlagId: string;
  debugLevelName: string;
  startDate?: string;
  expirationDate?: string;
  isActive: boolean;
}

export interface ApplyUserTraceFlagInput {
  userId: string;
  debugLevelName: string;
  ttlMinutes: number;
}
