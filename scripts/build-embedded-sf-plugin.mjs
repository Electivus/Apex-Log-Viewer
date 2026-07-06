import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const outdir = path.join(repoRoot, 'apps', 'vscode-extension', 'sf-plugin');

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'packages', 'sf-plugin', 'src', 'embedded.ts')],
  outfile: path.join(outdir, 'electivus-runner.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true
});
