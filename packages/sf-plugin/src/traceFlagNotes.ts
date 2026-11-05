import type { TraceFlagTargetStatus } from '@alv/core/contracts';

/**
 * The warning `trace-flag status` adds when an active flag of the other log type changes what the status means:
 * a DEVELOPER_LOG flag sets the level of a USER_DEBUG target, or a USER_DEBUG flag is all a DEVELOPER_LOG read misses.
 */
export function otherLogTypeWarning(status: TraceFlagTargetStatus): string | undefined {
  const other = status.targetAvailable ? status.otherLogType : undefined;
  if (!other?.isActive) return undefined;
  const where =
    status.target.type === 'user'
      ? 'on this target'
      : `on ${other.activeTargetCount} of ${status.resolvedTargetCount ?? 0} matched targets`;
  const until = other.expirationDate ? ` until ${other.expirationDate}` : '';
  if (status.logType === 'USER_DEBUG' && other.logType === 'DEVELOPER_LOG') {
    return `A DEVELOPER_LOG trace flag is also active ${where}${until}. Salesforce writes each transaction's log at that flag's debug level, so the USER_DEBUG level does not apply until then.`;
  }
  if (status.logType === 'DEVELOPER_LOG' && !status.isActive && other.logType === 'USER_DEBUG') {
    return `No active DEVELOPER_LOG trace flag, but a USER_DEBUG trace flag is active ${where}${until}. Run with --log-type USER_DEBUG to see it.`;
  }
  return undefined;
}
