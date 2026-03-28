import { normalizeLogTriageSummary } from '../../../apps/vscode-extension/src/shared/logTriage';

describe('normalizeLogTriageSummary', () => {
  it('keeps warning-only summaries out of hasErrors', () => {
    const summary = normalizeLogTriageSummary({
      hasErrors: false,
      primaryReason: 'Rollback detected',
      reasons: [
        {
          code: 'rollback_detected',
          severity: 'warning',
          summary: 'Rollback detected',
          line: 17,
          eventType: 'ROLLBACK'
        }
      ]
    });

    expect(summary.hasErrors).toBe(false);
    expect(summary.primaryReason).toBe('Rollback detected');
    expect(summary.reasons).toHaveLength(1);
    expect(summary.reasons[0]?.severity).toBe('warning');
  });
});
