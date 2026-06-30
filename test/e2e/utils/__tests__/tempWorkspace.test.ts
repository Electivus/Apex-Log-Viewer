import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTempWorkspace } from '../tempWorkspace';

describe('createTempWorkspace', () => {
  test('wraps npm-installed Salesforce CLI with the configured Node runtime on Unix', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), 'alv-temp-workspace-test-'));
    try {
      const nodeBinPath = path.join(root, 'node22', 'bin', 'node');
      const sfBinDir = path.join(root, 'node24', 'bin');
      const sfRunnerPath = path.join(root, 'node24', 'lib', 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
      const sfBinPath = path.join(sfBinDir, 'sf');

      await mkdir(path.dirname(nodeBinPath), { recursive: true });
      await mkdir(path.dirname(sfRunnerPath), { recursive: true });
      await mkdir(sfBinDir, { recursive: true });
      await writeFile(nodeBinPath, '#!/bin/sh\n', 'utf8');
      await writeFile(sfRunnerPath, '#!/usr/bin/env -S node --no-deprecation\n', 'utf8');
      await symlink('../lib/node_modules/@salesforce/cli/bin/run.js', sfBinPath);

      const workspace = await createTempWorkspace({
        targetOrg: 'ALV_E2E',
        sfCli: { sfBinPath, nodeBinPath }
      });
      try {
        const wrapperPath = path.join(workspace.workspacePath, '.vscode', 'sf-cli.sh');
        const settingsPath = path.join(workspace.workspacePath, '.vscode', 'settings.json');
        const wrapper = await readFile(wrapperPath, 'utf8');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));

        expect(settings['electivus.apexLogs.cliPath']).toBe(wrapperPath);
        expect(wrapper).toContain('unset ELECTRON_RUN_AS_NODE');
        expect(wrapper).toContain('unset NODE_OPTIONS');
        expect(wrapper).toContain(`export PATH="${path.dirname(nodeBinPath)}:$PATH"`);
        expect(wrapper).toContain(`exec "${nodeBinPath}" --no-deprecation "${sfRunnerPath}" "$@"`);
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
