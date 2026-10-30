import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * A source has a kind, and every layer reads rows by it. A two-way comparison such as
 * `kind === 'transactions' ? header : entry` routes a kind it has never heard of down the entry
 * branch without a compile error. The sites that read a kind switch on it and end in
 * `assertNever`, or index a table that `satisfies Record<kind, …>`, so the compiler lists every
 * site when a kind is added. This test refuses the comparisons themselves.
 */

const REPO = path.resolve(__dirname, '../../..');
const CORE = path.resolve(__dirname, '../src/customLogs');

/** Where the Custom Logs surfaces read a source kind. */
const SCANNED = [
  CORE,
  path.join(REPO, 'packages/protocol/src'),
  path.join(REPO, 'packages/webview/src'),
  path.join(REPO, 'packages/sf-plugin/src'),
  path.join(REPO, 'apps/vscode-extension/src')
];

/** The shape is built and narrowed in these two files, and nowhere else. */
const EXEMPT = [path.join(CORE, 'config.ts'), path.join(CORE, 'resolved.ts')];

const TEST_PATH = /(?:^|[\\/])(?:__tests__|node-test|test)(?:[\\/]|$)|\.test\.tsx?$/;
const KIND_COMPARISON = /\b(?:kind|shape)\s*[!=]==?\s*'(?:transactions|entries|events)'/g;

/** Every kind comparison under `dirs` outside `exempt` and test sources, as `file:line: <comparison>`. */
function kindComparisons(dirs: readonly string[], exempt: readonly string[]): string[] {
  return dirs.flatMap(dir =>
    fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(file => /\.tsx?$/.test(file) && !TEST_PATH.test(file))
      .map(file => path.join(dir, file))
      .filter(file => !exempt.includes(file))
      .flatMap(file => {
        const text = fs.readFileSync(file, 'utf8');
        return [...text.matchAll(KIND_COMPARISON)].map(match => {
          const line = text.slice(0, match.index).split('\n').length;
          return `${path.relative(dir, file)}:${line}: ${match[0]}`;
        });
      })
  );
}

test('a seeded kind comparison is reported, a switch, a literal, an exempt file and a test file are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-shape-'));
  try {
    const write = (name: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    };
    write('ternary.ts', `\nconst listed = shape.kind === 'transactions' ? shape.transaction : shape.entry;`);
    write('negated.tsx', `if (source.shape !== 'events') return;`);
    write(
      'switched.ts',
      `switch (shape.kind) {\n  case 'transactions':\n    return shape.transaction;\n  case 'entries':\n    return shape.entry;\n  default:\n    return assertNever(shape, 'source shape');\n}`
    );
    write('literal.ts', `const ref = { id: 'nebula', shape: 'transactions' };`);
    write('config.ts', `const exempt = kind === 'entries';`);
    write('nested/__tests__/seeded.ts', `const inTest = kind === 'entries';`);
    write('seeded.test.ts', `const inTest = kind === 'entries';`);

    assert.deepEqual(kindComparisons([dir], [path.join(dir, 'config.ts')]).sort(), [
      `negated.tsx:1: shape !== 'events'`,
      `ternary.ts:2: kind === 'transactions'`
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no source reads a kind by comparison outside config.ts and resolved.ts', () => {
  for (const dir of SCANNED) assert.ok(fs.existsSync(dir), `${dir} exists`);
  assert.deepEqual(kindComparisons(SCANNED, EXEMPT), []);
});
