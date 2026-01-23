import * as path from 'path';
import * as fs from 'fs';

// Use CommonJS import to align with Mocha's programmatic API
const Mocha = require('mocha');

function collectTests(dir: string, acc: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectTests(p, acc);
    } else if (/\.test\.js$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

export async function run(): Promise<void> {
  const outDir = path.resolve(__dirname);
  const testsRoot = outDir; // compiled tests live in out/test

  const timeout = Number(process.env.VSCODE_TEST_MOCHA_TIMEOUT_MS || 120000);
  const grep = process.env.VSCODE_TEST_GREP;
  const invert = /^1|true$/i.test(String(process.env.VSCODE_TEST_INVERT || ''));
  const fullTrace = /^1|true$/i.test(String(process.env.VSCODE_TEST_MOCHA_FULLTRACE || ''));

  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout,
    reporter: 'spec',
    forbidOnly: true,
    fullTrace
  });
  if (grep) {
    mocha.grep(grep);
    if (invert) {
      mocha.invert();
    }
  }

  // Ensure mocha hooks are loaded
  const setup = path.join(outDir, 'mocha.setup.js');
  if (fs.existsSync(setup)) {
    require(setup);
  }

  const files = collectTests(testsRoot);
  files.forEach(f => mocha.addFile(f));

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// When called by @vscode/test-electron, it will require this module
// and call the exported run() above.
