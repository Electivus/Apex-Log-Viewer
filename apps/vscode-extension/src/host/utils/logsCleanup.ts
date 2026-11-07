import { localize } from './localize';

export type LogsCleanupScope = 'all' | 'mine';

/** Title of the permanent-deletion confirmation. It names the org so the user sees what is about to be wiped. */
export function logsCleanupConfirmTitle(scope: LogsCleanupScope, orgName: string | undefined): string {
  if (orgName) {
    return scope === 'mine'
      ? localize('logsCleanup.confirmMineOrg.title', 'Delete your Apex logs for {0}?', orgName)
      : localize('logsCleanup.confirmAllOrg.title', 'Delete all Apex logs for {0}?', orgName);
  }
  return scope === 'mine'
    ? localize('logsCleanup.confirmMine.title', 'Delete your Apex logs for the selected org?')
    : localize('logsCleanup.confirmAll.title', 'Delete all Apex logs for the selected org?');
}
