import { build, context } from 'esbuild';

const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');
const minify = args.has('--minify');

const buildOptions = {
  entryPoints: ['apps/vscode-extension/src/extension.ts'],
  outfile: 'apps/vscode-extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  minify,
  external: ['vscode', 'tree-sitter-sfapex']
};

if (watchMode) {
  const watcher = await context(buildOptions);
  await watcher.watch();
  await new Promise(() => {});
} else {
  await build(buildOptions);
}
