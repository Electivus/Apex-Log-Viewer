import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempWorkspace } from '../tempWorkspace';

describe('createTempWorkspace', () => {
  test('uses the autonomous core without persisting a Salesforce CLI path setting', async () => {
    const workspace = await createTempWorkspace({
      targetOrg: 'ALV_E2E',
      sfCli: { sfBinPath: '/unused/sf', nodeBinPath: '/unused/node' }
    });
    try {
      const gitignore = await readFile(path.join(workspace.workspacePath, '.gitignore'), 'utf8');
      const settings = JSON.parse(
        await readFile(path.join(workspace.workspacePath, '.vscode', 'settings.json'), 'utf8')
      );
      expect(gitignore.split(/\r?\n/)).toContain('apexlogs/');
      expect(settings['electivus.apexLogViewer.logging.trace']).toBe(true);
      expect(Object.keys(settings).some(key => /cliPath/i.test(key))).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });
});
