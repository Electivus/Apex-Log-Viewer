import assert from 'assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarizeLogFile } from '../../../../src/services/logTriage';

suite('logTriage', () => {
  test('summarizeLogFile uses the shared structured analyzer', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-log-triage-'));
    const filePath = path.join(tempDir, 'validation.log');

    try {
      await fs.writeFile(
        filePath,
        '17:11:52.319|VARIABLE_ASSIGNMENT|[131]|error|"Error [statusCode=FIELD_CUSTOM_VALIDATION_EXCEPTION, message=Could not save]"|0x1\n' +
          '17:11:52.525|ROLLBACK|[111]|Savepoint restored\n',
        'utf8'
      );

      const summary = await summarizeLogFile(filePath);

      assert.equal(summary.hasErrors, true);
      assert.equal(summary.primaryReason, 'Validation failure');
      assert.deepEqual(
        summary.reasons.map(reason => reason.code),
        ['validation_failure', 'rollback_detected']
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('a file read failure does not affect later triage requests', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-log-triage-read-'));
    const healthyPath = path.join(tempDir, 'healthy.log');

    try {
      await assert.rejects(summarizeLogFile(path.join(tempDir, 'missing.log')), { code: 'ENOENT' });
      await fs.writeFile(healthyPath, '17:11:53.0|EXCEPTION_THROWN|[6]|System.NullPointerException: boom\n', 'utf8');

      const summary = await summarizeLogFile(healthyPath);

      assert.equal(summary.hasErrors, true);
      assert.equal(summary.primaryReason, 'Fatal exception');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
