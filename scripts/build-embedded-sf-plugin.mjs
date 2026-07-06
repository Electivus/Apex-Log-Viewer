import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outdir = path.join(repoRoot, 'apps', 'vscode-extension', 'sf-plugin');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'packages', 'sf-plugin', 'src', 'embedded.ts')],
  outfile: path.join(outdir, 'electivus-runner.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true
});
