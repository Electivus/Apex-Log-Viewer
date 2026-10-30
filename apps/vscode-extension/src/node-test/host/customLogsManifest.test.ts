import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');
const SETTING = 'electivus.apexLogViewer.customLogs.enabled';
const GATE = `config.${SETTING}`;
const CUSTOM_LOGS_COMMAND = /^electivus\.apexLogViewer\.customLogs\./;
const CUSTOM_LOGS_VIEW = 'electivus.apexLogViewer.customLogsView';

type Manifest = {
  contributes: {
    configuration: {
      properties: Record<string, { type?: string; default?: unknown; tags?: string[]; markdownDescription?: string }>;
    };
    views: Record<string, Array<{ id: string; when?: string }>>;
    commands: Array<{ command: string; enablement?: string }>;
    menus: { commandPalette?: Array<{ command: string; when?: string }> };
  };
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(extensionRoot, file), 'utf8')) as T;
}

const manifest = readJson<Manifest>('package.json');
const customLogsCommands = manifest.contributes.commands.filter(entry => CUSTOM_LOGS_COMMAND.test(entry.command));

suite('Custom Logs experimental setting (manifest)', () => {
  test('is a boolean that defaults to off and is tagged experimental', () => {
    const setting = manifest.contributes.configuration.properties[SETTING];

    assert.equal(setting?.type, 'boolean');
    assert.equal(setting?.default, false);
    assert.deepEqual(setting?.tags, ['experimental']);
  });

  test('describes the experimental panel in every shipped language', () => {
    const key = manifest.contributes.configuration.properties[SETTING]?.markdownDescription?.replace(/^%|%$/g, '');
    assert.ok(key, 'the description is localized through package.nls');

    for (const file of ['package.nls.json', 'package.nls.pt-br.json']) {
      const description = readJson<Record<string, string>>(file)[key];
      assert.ok(description, `${file} has ${key}`);
      assert.match(description, /Experimental/, `${file} says the feature is experimental`);
      assert.match(description, /custom-log/, `${file} says the CLI does not depend on the setting`);
    }
  });

  test('hides the Custom Logs view, and with it its panel tab, while the setting is off', () => {
    const views = Object.values(manifest.contributes.views).flat();
    const view = views.find(entry => entry.id === CUSTOM_LOGS_VIEW);

    assert.equal(view?.when, GATE);
    const container = Object.entries(manifest.contributes.views).find(([, entries]) => entries.includes(view!));
    assert.deepEqual(
      container?.[1].map(entry => entry.id),
      [CUSTOM_LOGS_VIEW],
      'the container holds only the gated view, so VS Code removes it too'
    );
  });

  test('disables every Custom Logs command and drops it from the command palette while the setting is off', () => {
    assert.deepEqual(customLogsCommands.map(entry => entry.command).sort(), [
      'electivus.apexLogViewer.customLogs.configure',
      'electivus.apexLogViewer.customLogs.openEditor',
      'electivus.apexLogViewer.customLogs.refresh'
    ]);
    const palette = manifest.contributes.menus.commandPalette ?? [];

    for (const { command, enablement } of customLogsCommands) {
      assert.equal(enablement, GATE, `${command} is enabled only by the setting`);
      assert.equal(
        palette.find(entry => entry.command === command)?.when,
        GATE,
        `${command} is hidden from the palette`
      );
    }
  });

  test('leaves the Logs and Tail entry points ungated', () => {
    const others = manifest.contributes.commands.filter(entry => !CUSTOM_LOGS_COMMAND.test(entry.command));
    const palette = manifest.contributes.menus.commandPalette ?? [];

    assert.ok(others.length > 0);
    for (const { command, enablement } of others) {
      assert.equal(enablement, undefined, `${command} stays enabled`);
      assert.equal(
        palette.some(entry => entry.command === command),
        false,
        `${command} stays in the palette`
      );
    }
    const ungatedViews = Object.values(manifest.contributes.views)
      .flat()
      .filter(entry => entry.id !== CUSTOM_LOGS_VIEW);
    assert.deepEqual(
      ungatedViews.map(entry => entry.when),
      ungatedViews.map(() => undefined)
    );
  });
});
