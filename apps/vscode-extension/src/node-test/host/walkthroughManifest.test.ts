import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const extensionRoot = path.resolve(__dirname, '..', '..', '..');

type Step = { id: string; title: string; description: string; media: { markdown: string }; completionEvents: string[] };
type Manifest = {
  files: string[];
  contributes: { commands: Array<{ command: string }>; walkthroughs: Array<{ steps: Step[] }> };
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(extensionRoot, file), 'utf8')) as T;
const manifest = readJson<Manifest>('package.json');
const nls = {
  en: readJson<Record<string, string>>('package.nls.json'),
  ptBr: readJson<Record<string, string>>('package.nls.pt-br.json')
};
const steps = manifest.contributes.walkthroughs.flatMap(walkthrough => walkthrough.steps);
const nlsKey = (value: string) => /^%(.+)%$/.exec(value)?.[1] ?? assert.fail(`${value} is not a %key%`);

suite('Getting started walkthrough (manifest)', () => {
  test('has the four steps, each with a completion event', () => {
    assert.deepEqual(
      steps.map(step => step.id),
      ['openPanel', 'chooseOrg', 'debugFlags', 'openLog']
    );
    for (const step of steps) {
      assert.ok(step.completionEvents.length > 0, step.id);
    }
  });

  test('ships every step Markdown, in English and pt-BR, through the files allowlist', () => {
    assert.ok(manifest.files.includes('media/walkthrough/**'));
    for (const step of steps) {
      const english = step.media.markdown;
      assert.ok(existsSync(path.join(extensionRoot, english)), english);
      assert.ok(existsSync(path.join(extensionRoot, english.replace(/\.md$/, '.nls.pt-br.md'))), `${english} pt-br`);
    }
  });

  test('translates every string and links only registered commands', () => {
    const registered = new Set(manifest.contributes.commands.map(entry => entry.command));
    for (const step of steps) {
      for (const key of [nlsKey(step.title), nlsKey(step.description)]) {
        assert.ok(nls.en[key], `${key} in English`);
        assert.ok(nls.ptBr[key], `${key} in pt-BR`);
      }
      const linked = [...(nls.en[nlsKey(step.description)] ?? '').matchAll(/\]\(command:([^)]+)\)/g)].map(m => m[1]);
      assert.ok(linked.length > 0, `${step.id} has a button`);
      for (const id of linked) {
        assert.ok(registered.has(id ?? '') || id?.endsWith('.focus'), `${step.id} links ${id}`);
      }
    }
  });
});
