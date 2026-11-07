import type { DebugFlagUser } from '@alv/protocol/debugFlagsTypes';

export type ApplyBlocker = 'noTarget' | 'noDebugLevel';

export function isAuthenticatedUser(user: DebugFlagUser, authenticatedUsername: string | undefined): boolean {
  const username = (authenticatedUsername ?? '').trim().toLowerCase();
  return username !== '' && user.username.toLowerCase() === username;
}

export function orderUsersForPicker(
  users: DebugFlagUser[],
  authenticatedUsername: string | undefined
): DebugFlagUser[] {
  const own = users.filter(user => isAuthenticatedUser(user, authenticatedUsername));
  if (own.length === 0) {
    return users;
  }
  return [...own, ...users.filter(user => !isAuthenticatedUser(user, authenticatedUsername))];
}

export function getApplyBlocker(input: { hasTarget: boolean; hasDebugLevel: boolean }): ApplyBlocker | undefined {
  if (!input.hasTarget) {
    return 'noTarget';
  }
  return input.hasDebugLevel ? undefined : 'noDebugLevel';
}
