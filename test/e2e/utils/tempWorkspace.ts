import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { envFlag } from './envFlag';
import { removePathBestEffort } from './fsCleanup';
import { timeE2eStep } from './timing';

export type TempWorkspace = {
  workspacePath: string;
  cleanup: (options?: { keep?: boolean }) => Promise<void>;
};

function resolveDefaultWorkspaceSettings(overrides?: Record<string, unknown>): Record<string, unknown> {
  const defaultLogLevel = process.env.VSCODE_TEST_LOG_LEVEL || process.env.VSCODE_LOG_LEVEL || 'trace';
  return {
    // Keep extension tracing enabled during E2E runs so preserved user-data/logs
    // contain enough detail to diagnose runtime or UI flakiness afterward.
    'sfLogs.trace': true,
    'window.logLevel': String(defaultLogLevel),
    ...(overrides || {})
  };
}

function shouldKeepTempWorkspace(): boolean {
  return envFlag('ALV_E2E_KEEP_WORKSPACE');
}

export async function createTempWorkspace(options: {
  targetOrg: string;
  sfCli?: { sfBinPath: string; nodeBinPath: string };
  settings?: Record<string, unknown>;
}): Promise<TempWorkspace> {
  return await timeE2eStep('workspace.create', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'alv-e2e-ws-'));

    const proj = {
      packageDirectories: [{ path: 'force-app', default: true }],
      name: 'apex-log-viewer-e2e',
      namespace: '',
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: String(process.env.SF_TEST_API_VERSION || '60.0')
    };
    await writeFile(path.join(workspacePath, 'sfdx-project.json'), JSON.stringify(proj, null, 2), 'utf8');
    await mkdir(path.join(workspacePath, 'force-app'), { recursive: true });

    const sfDir = path.join(workspacePath, '.sf');
    await mkdir(sfDir, { recursive: true });
    await writeFile(
      path.join(sfDir, 'config.json'),
      JSON.stringify({ 'target-org': options.targetOrg }, null, 2),
      'utf8'
    );

    // Ensure the extension host can locate the Salesforce CLI even when VS Code
    // is launched in an environment with a minimal PATH.
    if (options.sfCli?.sfBinPath) {
      const vscodeDir = path.join(workspacePath, '.vscode');
      await mkdir(vscodeDir, { recursive: true });

      const settings = resolveDefaultWorkspaceSettings(options.settings);
      let cliPath = options.sfCli.sfBinPath;
      // On Unix-like systems, wrap `sf` so it can find `node` even if VS Code
      // starts with a minimal PATH.
      if (process.platform !== 'win32' && options.sfCli.nodeBinPath) {
        const wrapperPath = path.join(vscodeDir, 'sf-cli.sh');
        const nodeDir = path.dirname(options.sfCli.nodeBinPath);
        const script = [
          '#!/bin/bash',
          'set -euo pipefail',
          `export PATH="${nodeDir}:$PATH"`,
          `exec "${options.sfCli.sfBinPath}" "$@"`,
          ''
        ].join('\n');
        await writeFile(wrapperPath, script, 'utf8');
        await chmod(wrapperPath, 0o755);
        cliPath = wrapperPath;
      }
      settings['electivus.apexLogs.cliPath'] = cliPath;
      await writeFile(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    } else {
      const vscodeDir = path.join(workspacePath, '.vscode');
      await mkdir(vscodeDir, { recursive: true });
      await writeFile(
        path.join(vscodeDir, 'settings.json'),
        JSON.stringify(resolveDefaultWorkspaceSettings(options.settings), null, 2),
        'utf8'
      );
    }

    return {
      workspacePath,
      cleanup: async (cleanupOptions?: { keep?: boolean }) => {
        if (cleanupOptions?.keep || shouldKeepTempWorkspace()) {
          console.warn(`[e2e] Preserving temp workspace at ${workspacePath}`);
          return;
        }
        await removePathBestEffort(workspacePath);
      }
    };
  });
}
