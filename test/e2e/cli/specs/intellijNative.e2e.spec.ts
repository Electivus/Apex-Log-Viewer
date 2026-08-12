import { spawn } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../fixtures/alvCliE2E';

test.skip(process.env.ALV_INTELLIJ_REAL_ORG_E2E !== '1', 'IntelliJ native real-org lane is not enabled');

test('IntelliJ native runtime lists and materializes the seeded Apex log', async ({
  scratchAlias,
  seededLog,
  workspacePath
}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const pluginRoot = path.join(repoRoot, 'apps', 'intellij-plugin');
  const gradleArgs = ['--no-daemon', 'test', '--tests', 'com.electivus.apexlogviewer.runtime.ApexLogViewerRealOrgTest'];
  const invocation =
    process.platform === 'win32'
      ? {
          command: process.env.ComSpec || 'cmd.exe',
          args: ['/d', '/s', '/c', 'gradlew.bat', ...gradleArgs]
        }
      : { command: './gradlew', args: gradleArgs };

  const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: pluginRoot,
      env: {
        ...process.env,
        ALV_INTELLIJ_REAL_ORG_TARGET: scratchAlias,
        ALV_INTELLIJ_REAL_ORG_LOG_ID: seededLog.logId,
        ALV_INTELLIJ_REAL_ORG_WORKSPACE: workspacePath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });

  await testInfo.attach('intellij-native-gradle.stdout', {
    body: Buffer.from(result.stdout, 'utf8'),
    contentType: 'text/plain'
  });
  await testInfo.attach('intellij-native-gradle.stderr', {
    body: Buffer.from(result.stderr, 'utf8'),
    contentType: 'text/plain'
  });
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
});
