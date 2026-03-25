import { test } from '../fixtures/alvNoSeed';
import {
  getOrgAuth,
  removeDebugTraceFlagsByTracedEntityId,
  resolveSpecialTraceFlagTarget
} from '../utils/tooling';
import { assertSpecialTargetBehavior, openDebugFlagsFromLogs } from './debugFlagsPanel.shared';

test('supports special trace flag targets in the debug flags panel', async ({ scratchAlias, vscodePage }) => {
  const auth = await getOrgAuth(scratchAlias);
  const automatedProcessTarget = await resolveSpecialTraceFlagTarget(auth, 'automatedProcess');
  const platformIntegrationTarget = await resolveSpecialTraceFlagTarget(auth, 'platformIntegration');

  if (automatedProcessTarget?.ids?.length) {
    for (const tracedEntityId of automatedProcessTarget.ids) {
      await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
    }
  }
  if (platformIntegrationTarget?.ids?.length) {
    for (const tracedEntityId of platformIntegrationTarget.ids) {
      await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
    }
  }

  try {
    const debugFlagsFrame = await openDebugFlagsFromLogs(vscodePage);

    await assertSpecialTargetBehavior(debugFlagsFrame, auth, 'automatedProcess');
    await assertSpecialTargetBehavior(debugFlagsFrame, auth, 'platformIntegration');
  } finally {
    if (automatedProcessTarget?.ids?.length) {
      for (const tracedEntityId of automatedProcessTarget.ids) {
        await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
      }
    }
    if (platformIntegrationTarget?.ids?.length) {
      for (const tracedEntityId of platformIntegrationTarget.ids) {
        await removeDebugTraceFlagsByTracedEntityId(auth, tracedEntityId).catch(() => {});
      }
    }
  }
});
