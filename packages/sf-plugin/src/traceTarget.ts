import type { TraceFlagTarget } from '@alv/core/contracts';

export type TraceTargetFlags = {
  'automated-process': boolean;
  'current-user': boolean;
  'platform-integration': boolean;
  'user-id'?: string;
};

export function traceTarget(flags: TraceTargetFlags): TraceFlagTarget {
  const selected = [
    flags['user-id'] ? '--user-id' : undefined,
    flags['current-user'] ? '--current-user' : undefined,
    flags['automated-process'] ? '--automated-process' : undefined,
    flags['platform-integration'] ? '--platform-integration' : undefined
  ].filter((value): value is string => Boolean(value));
  if (selected.length > 1) throw new Error(`Trace flag target options are mutually exclusive: ${selected.join(', ')}.`);
  if (flags['user-id']) return { type: 'user', userId: flags['user-id'] };
  if (flags['automated-process']) return { type: 'automatedProcess' };
  if (flags['platform-integration']) return { type: 'platformIntegration' };
  return { type: 'user', userId: 'current' };
}
