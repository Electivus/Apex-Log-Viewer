import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = path.resolve(__dirname, '../src');
const CUSTOM_LOGS = path.join(SRC, 'customLogs');
const EVENTS = path.join(CUSTOM_LOGS, 'events');
const API = path.join(CUSTOM_LOGS, 'api.ts');
const PROTOCOL = path.resolve(__dirname, '../../protocol/src');
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(dir, file));
}

const importTargets = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)]
    .map(match => match[1]!)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => path.resolve(path.dirname(file), specifier).replace(/\.(?:js|ts)$/, ''));

test('only api.ts imports the event store, transport, capture and read modules', () => {
  const violations = sourceFiles(SRC)
    .filter(file => file !== API && !file.startsWith(EVENTS + path.sep))
    .flatMap(file =>
      importTargets(file)
        .filter(target => target === EVENTS || target.startsWith(EVENTS + path.sep))
        .map(target => `${path.relative(SRC, file)} imports ${path.relative(SRC, target)}`)
    );
  assert.deepEqual(violations, []);
});

test('readCursor is called only by the CometD adapter, which owns the cursor tag', () => {
  const allowed = new Set([path.join(EVENTS, 'ids.ts'), path.join(EVENTS, 'cometd.ts')]);
  const users = sourceFiles(SRC)
    .filter(file => /\breadCursor\b/.test(fs.readFileSync(file, 'utf8')) && !allowed.has(file))
    .map(file => path.relative(SRC, file));
  assert.deepEqual(users, []);
});

test('no data transfer type of the contract or the protocol holds a replay cursor', () => {
  const dtoFiles = [
    path.join(CUSTOM_LOGS, 'contracts.ts'),
    ...sourceFiles(PROTOCOL).filter(file => /customLog/i.test(path.basename(file)))
  ];
  assert.ok(dtoFiles.length > 1, 'the protocol custom log files were found');
  const holders = dtoFiles
    .filter(file => /\bReplayCursor\b|\breplayId\b/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(path.resolve(SRC, '../..'), file));
  assert.deepEqual(holders, []);
});
