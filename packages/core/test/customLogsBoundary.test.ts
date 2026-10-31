import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = path.resolve(__dirname, '../src');
const CUSTOM_LOGS = path.join(SRC, 'customLogs');
const ENTRY_POINTS = new Set(['api', 'contracts'].map(name => path.join(CUSTOM_LOGS, `${name}.js`)));
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(dir, file));
}

test('code outside customLogs/ imports only its api and contracts modules', () => {
  const violations = sourceFiles(SRC)
    .filter(file => !file.startsWith(CUSTOM_LOGS + path.sep))
    .flatMap(file =>
      [...fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map(match => match[1])
        .filter(specifier => specifier.startsWith('.'))
        .map(specifier => path.resolve(path.dirname(file), specifier))
        .filter(target => target.startsWith(CUSTOM_LOGS + path.sep) && !ENTRY_POINTS.has(target))
        .map(target => `${path.relative(SRC, file)} imports ${path.relative(SRC, target)}`)
    );
  assert.deepEqual(violations, []);
});

const WORKSPACE_FS = path.join(SRC, 'localStore', 'workspaceFs');
const WORKSPACE_FS_IMPORTERS = new Set([
  path.join(SRC, 'logLifecycle.ts'),
  path.join(CUSTOM_LOGS, 'events', 'store.ts')
]);

test('only logLifecycle.ts and customLogs/events/store.ts import localStore/workspaceFs.ts', () => {
  const violations = sourceFiles(SRC)
    .filter(file => !WORKSPACE_FS_IMPORTERS.has(file))
    .flatMap(file =>
      [...fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)]
        .map(match => match[1])
        .filter(specifier => specifier.startsWith('.'))
        .map(specifier => path.resolve(path.dirname(file), specifier).replace(/\.(?:js|ts)$/, ''))
        .filter(target => target === WORKSPACE_FS)
        .map(() => `${path.relative(SRC, file)} imports localStore/workspaceFs.ts`)
    );
  assert.deepEqual(violations, []);
});

test('every error customLogs/ throws is built by customLogError, so its code is in the contract', () => {
  const builders = sourceFiles(CUSTOM_LOGS)
    .filter(file => file !== path.join(CUSTOM_LOGS, 'errors.ts'))
    .filter(file => /new AlvError\(/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC, file));
  assert.deepEqual(builders, []);
});
