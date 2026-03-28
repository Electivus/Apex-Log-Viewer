import * as path from 'path';
import * as fs from 'fs';
import { transformSync } from 'esbuild';

// Use CommonJS import to align with Mocha's programmatic API
const Mocha = require('mocha');

function collectTests(dir: string, acc: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectTests(p, acc);
    } else if (/\.test\.ts$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function registerTypeScriptLoader(repoRoot: string): void {
  const previousTs = require.extensions['.ts'];
  const previousTsx = require.extensions['.tsx'];

  const compile = (module: NodeJS.Module, filename: string) => {
    const normalizedFilename = path.normalize(filename);
    const withinRepo = normalizedFilename.startsWith(path.normalize(repoRoot) + path.sep);
    if (!withinRepo || normalizedFilename.includes(`${path.sep}node_modules${path.sep}`)) {
      if (filename.endsWith('.tsx') && previousTsx) {
        previousTsx(module, filename);
        return;
      }
      if (previousTs) {
        previousTs(module, filename);
        return;
      }
      throw new Error(`No loader available for ${filename}`);
    }

    const source = fs.readFileSync(filename, 'utf8');
    const loader = filename.endsWith('.tsx') ? 'tsx' : 'ts';
    const { code } = transformSync(source, {
      loader,
      format: 'cjs',
      target: 'es2022',
      sourcemap: 'inline',
      sourcefile: filename,
      tsconfigRaw: {
        compilerOptions: {
          jsx: 'react-jsx'
        }
      }
    });

    (module as NodeJS.Module & { _compile(code: string, filename: string): void })._compile(code, filename);
  };

  require.extensions['.ts'] = compile;
  require.extensions['.tsx'] = compile;
}

export async function run(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const testsRoot = path.join(repoRoot, 'apps', 'vscode-extension', 'src', 'test');
  registerTypeScriptLoader(repoRoot);

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
  const setup = path.join(testsRoot, 'mocha.setup.ts');
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
